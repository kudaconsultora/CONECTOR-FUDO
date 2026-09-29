// Conector Fudo para Claude — Mandy's Comidas
// Solo LECTURA: no crea, modifica ni borra nada en Fudo.
//
// Variables de entorno necesarias:
//   FUDO_API_KEY     -> API Key del usuario de API en Fudo
//   FUDO_API_SECRET  -> API Secret de ese usuario
//   CLAVE_CONECTOR   -> una clave larga inventada (protege la dirección del conector)
//   PORT             -> (opcional) puerto, por defecto 3000

import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { controlPrecios } from "./control-precios.js";

const { FUDO_API_KEY, FUDO_API_SECRET, CLAVE_CONECTOR, PORT = 3000 } = process.env;
if (!FUDO_API_KEY || !FUDO_API_SECRET || !CLAVE_CONECTOR) {
  console.error("Faltan variables: FUDO_API_KEY, FUDO_API_SECRET y CLAVE_CONECTOR");
  process.exit(1);
}

const API = "https://api.fu.do/v1alpha1";
const AUTH = "https://auth.fu.do/api";
const TZ = "-03:00"; // hora de Argentina

// ---------- Cliente Fudo ----------
let token = null;
let tokenVence = 0;

async function obtenerToken() {
  if (token && Date.now() < tokenVence - 60_000) return token;
  const r = await fetch(AUTH, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ apiKey: FUDO_API_KEY, apiSecret: FUDO_API_SECRET }),
  });
  if (!r.ok) throw new Error(`Fudo rechazó las credenciales (${r.status})`);
  const d = await r.json();
  token = d.token;
  tokenVence = Number(d.exp) * 1000 || Date.now() + 23 * 3600_000;
  return token;
}

async function fudoGet(ruta, params = {}, reintento = true) {
  const url = new URL(API + ruta);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, v);
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${await obtenerToken()}`, Accept: "application/json" },
  });
  if (r.status === 401 && reintento) { token = null; return fudoGet(ruta, params, false); }
  if (!r.ok) throw new Error(`Fudo respondió ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

// Trae todas las páginas (hasta un tope, para no colgarse)
async function fudoTodo(ruta, params = {}, maxPaginas = 40) {
  const datos = [], incluidos = [];
  for (let n = 1; n <= maxPaginas; n++) {
    const d = await fudoGet(ruta, { ...params, "page[size]": "500", "page[number]": String(n) });
    datos.push(...(d.data || []));
    incluidos.push(...(d.included || []));
    if (!d.data || d.data.length < 500) break;
  }
  return { datos, incluidos };
}

// ---------- Ayudas ----------
const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Fecha AAAA-MM-DD");

function rangoUTC(desde, hasta) {
  const a = new Date(`${desde}T00:00:00${TZ}`).toISOString().slice(0, 19) + "Z";
  const b = new Date(`${hasta}T23:59:59${TZ}`).toISOString().slice(0, 19) + "Z";
  return `and(gte.${a},lte.${b})`;
}

const diaAR = (iso) => new Date(new Date(iso).getTime() - 3 * 3600_000).toISOString().slice(0, 10);

function indexar(incluidos) {
  const m = new Map();
  for (const x of incluidos) m.set(`${x.type}:${x.id}`, x);
  return m;
}
const rel = (obj, nombre) => obj.relationships?.[nombre]?.data;

function sumar(mapa, clave, monto) {
  const c = mapa[clave] || (mapa[clave] = { cantidad: 0, total: 0 });
  c.cantidad++; c.total = Math.round((c.total + monto) * 100) / 100;
}

// Costos actuales de todos los ingredientes: Map id -> costo, y lista {name, cost}
async function costosIngredientes() {
  const { datos } = await fudoTodo("/ingredients", { "fields[ingredient]": "name,cost" });
  const porId = new Map(), lista = [];
  for (const x of datos) {
    const c = Number(x.attributes?.cost);
    if (c > 0) { porId.set(String(x.id), c); lista.push({ name: x.attributes.name, cost: c }); }
  }
  return { porId, lista };
}

// Productos con costo, precio, categoría y si están activos
async function productosFudo() {
  const { datos, incluidos } = await fudoTodo("/products", {
    include: "productCategory",
    "fields[product]": "name,active,cost,componentsCost,price,productCategory",
  });
  const idx = indexar(incluidos);
  return datos.map((p) => {
    const a = p.attributes || {}, c = rel(p, "productCategory");
    return {
      Producto: a.name, Categoria: c ? idx.get(`${c.type}:${c.id}`)?.attributes?.name || "" : "",
      Costo: (a.cost > 0 ? a.cost : a.componentsCost > 0 ? Math.round(a.componentsCost * 100) / 100 : ""), Precio: a.price ?? "", Activo: a.active ? "Si" : "No",
    };
  });
}

const texto = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });

// ---------- Herramientas ----------
function crearServidor() {
  const s = new McpServer({ name: "fudo-mandys", version: "1.0.0" });

  s.tool(
    "resumen_ventas",
    "Resumen de ventas CERRADAS de Fudo entre dos fechas (hora Argentina): total, por día, por tipo (local/mostrador/delivery), por origen (app de delivery, tienda online, etc.) y por medio de pago. Ojo: Fudo registra las ventas de apps en bruto, sin descontar comisiones.",
    { desde: fecha, hasta: fecha },
    async ({ desde, hasta }) => {
      const { datos, incluidos } = await fudoTodo("/sales", {
        "filter[createdAt]": rangoUTC(desde, hasta),
        "filter[saleState]": "in.(CLOSED)",
        include: "payments.paymentMethod,orders",
      });
      const idx = indexar(incluidos);
      const r = { desde, hasta, cantidad_ventas: 0, total: 0, por_dia: {}, por_tipo: {}, por_origen: {}, por_medio_de_pago: {} };
      for (const v of datos) {
        const a = v.attributes || {};
        const total = Number(a.total) || 0;
        r.cantidad_ventas++; r.total = Math.round((r.total + total) * 100) / 100;
        sumar(r.por_dia, diaAR(a.createdAt), total);
        sumar(r.por_tipo, a.saleType || "sin dato", total);
        const ords = (rel(v, "orders") || []).map((o) => idx.get(`${o.type}:${o.id}`)?.attributes?.origin).filter(Boolean);
        sumar(r.por_origen, ords[0] || "Fudo (local/propio)", total);
        for (const p of rel(v, "payments") || []) {
          const pago = idx.get(`${p.type}:${p.id}`);
          if (!pago || pago.attributes?.canceled) continue;
          const mp = rel(pago, "paymentMethod");
          const nombre = mp ? idx.get(`${mp.type}:${mp.id}`)?.attributes?.name : null;
          const m = r.por_medio_de_pago[nombre || "sin dato"] ||= { total: 0 };
          m.total = Math.round((m.total + (Number(pago.attributes?.amount) || 0)) * 100) / 100;
        }
      }
      return texto(r);
    }
  );

  s.tool(
    "listar_ventas",
    "Lista ventas de Fudo entre dos fechas con su detalle (productos, pagos, cliente). Útil para revisar ventas puntuales. Máximo 500 por consulta.",
    {
      desde: fecha, hasta: fecha,
      estado: z.enum(["CLOSED", "CANCELED", "PENDING", "IN-COURSE"]).optional().describe("Por defecto CLOSED"),
      tipo: z.enum(["EAT-IN", "TAKEAWAY", "DELIVERY"]).optional(),
    },
    async ({ desde, hasta, estado = "CLOSED", tipo }) => {
      const d = await fudoGet("/sales", {
        "filter[createdAt]": rangoUTC(desde, hasta),
        "filter[saleState]": `in.(${estado})`,
        "filter[saleType]": tipo ? `eq.${tipo}` : undefined,
        include: "items.product,payments.paymentMethod,orders,customer",
        "page[size]": "500",
        sort: "createdAt",
      });
      return texto(d);
    }
  );

  s.tool(
    "resumen_gastos",
    "Resumen de gastos cargados en Fudo entre dos fechas (fecha del gasto): total, por categoría, por proveedor y detalle de cada gasto. No incluye gastos anulados. Recordá que hay gastos que salen de la caja y NO se cargan en Fudo.",
    { desde: fecha, hasta: fecha },
    async ({ desde, hasta }) => {
      const { datos, incluidos } = await fudoTodo("/expenses", {
        "filter[date]": `and(gte.${desde},lte.${hasta})`,
        "filter[canceled]": "neq.true",
        include: "expenseCategory,provider,paymentMethod",
      });
      const idx = indexar(incluidos);
      const nom = (g, n) => { const x = rel(g, n); return x ? idx.get(`${x.type}:${x.id}`)?.attributes?.name : null; };
      const r = { desde, hasta, cantidad: 0, total: 0, por_categoria: {}, por_proveedor: {}, detalle: [] };
      for (const g of datos) {
        const a = g.attributes || {};
        const monto = Number(a.amount) || 0;
        const cat = nom(g, "expenseCategory") || "sin categoría";
        const prov = nom(g, "provider") || "sin proveedor";
        r.cantidad++; r.total = Math.round((r.total + monto) * 100) / 100;
        sumar(r.por_categoria, cat, monto);
        sumar(r.por_proveedor, prov, monto);
        r.detalle.push({ fecha: a.date, monto, categoria: cat, proveedor: prov, descripcion: a.description || "", estado: a.status, medio_pago: nom(g, "paymentMethod") });
      }
      return texto(r);
    }
  );

  const RECURSOS = ["products", "product-categories", "ingredients", "expense-categories", "payment-methods", "providers", "customers", "discounts", "items", "payments", "users"];
  s.tool(
    "consultar_fudo",
    "Consulta genérica de solo lectura a la API de Fudo, para datos que las otras herramientas no cubren (productos, ingredientes y costos, categorías, proveedores, clientes, descuentos, medios de pago). Los parámetros siguen el formato de la API de Fudo, por ejemplo {\"page[size]\":\"500\",\"include\":\"productCategory\"}.",
    {
      recurso: z.enum(RECURSOS),
      id: z.string().optional().describe("ID puntual (opcional)"),
      parametros: z.record(z.string()).optional(),
    },
    async ({ recurso, id, parametros = {} }) => texto(await fudoGet(`/${recurso}${id ? "/" + encodeURIComponent(id) : ""}`, parametros))
  );

  s.tool(
    "control_precios_congelados",
    "Control de precios de la línea de CONGELADOS (planilla 0_MAESTRO: listas de vendedor y comercio). Recalcula costos con los costos actuales de los ingredientes en Fudo y avisa qué insumos cambiaron y qué productos quedaron con el precio de lista atrasado (más de 5% por debajo del sugerido).",
    {},
    async () => texto(controlPrecios((await costosIngredientes()).porId))
  );

  s.tool(
    "control_precios_local",
    "Control de precios de la carta del LOCAL según Fudo (misma regla que el gestor de precios): marca los productos activos cuyo precio quedó por debajo del mínimo = costo / (1 - margen). Margen 60% elaboración propia y 45% bebidas/tercerizados. También da el precio para cada app (PedidosYa ×1,50, Rappi ×1,30, Uber Eats ×1,20). Ojo: en Fudo algunos combos de empanadas tienen el costo inflado.",
    {
      margen_propio: z.number().optional().describe("Por defecto 0.60"),
      margen_tercerizado: z.number().optional().describe("Por defecto 0.45"),
    },
    async ({ margen_propio = 0.6, margen_tercerizado = 0.45 }) => {
      const TERCER = /(bebida|tequeñ|postre|helado|chocolate|coca|sprite|fanta|agua|cerveza|vino|aquarius|pepsi|brio|h2o|levite|schweppes|quilmes|andes|stella|heineken|imperial|lata|gaseosa|soda|raba)/i;
      const filas = (await productosFudo()).filter((p) => p.Activo === "Si" && Number(p.Costo) > 0 && Number(p.Precio) > 0 && !/eliminad/i.test(p.Categoria));
      const atrasados = [];
      for (const p of filas) {
        const m = TERCER.test(p.Producto) || TERCER.test(p.Categoria) ? margen_tercerizado : margen_propio;
        const minimo = Math.round(Number(p.Costo) / (1 - m));
        if (Number(p.Precio) < minimo) atrasados.push({
          producto: p.Producto, categoria: p.Categoria, costo: Number(p.Costo), precio_actual: Number(p.Precio), precio_minimo: minimo,
          falta: `${(((minimo - p.Precio) / p.Precio) * 100).toFixed(1)}%`,
          pedidosya: Math.round(minimo * 1.5), rappi: Math.round(minimo * 1.3), uber: Math.round(minimo * 1.2),
        });
      }
      return texto({ productos_revisados: filas.length, cantidad_atrasados: atrasados.length, atrasados: atrasados.sort((a, b) => parseFloat(b.falta) - parseFloat(a.falta)) });
    }
  );

  return s;
}

// ---------- Servidor HTTP ----------
const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => res.send("Conector Fudo de Mandy's funcionando ✔"));

app.all(`/mcp/${CLAVE_CONECTOR}`, async (req, res) => {
  try {
    const servidor = crearServidor();
    const transporte = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transporte.close(); servidor.close(); });
    await servidor.connect(transporte);
    await transporte.handleRequest(req, res, req.body);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ error: "Error interno" });
  }
});

// ---------- Datos para las herramientas HTML (calculadora y gestor) ----------
const cors = (res) => { res.set("Access-Control-Allow-Origin", "*"); res.set("Cache-Control", "no-store"); };

app.get(`/costos/${CLAVE_CONECTOR}`, async (_req, res) => {
  cors(res);
  try { res.json({ ok: true, ingredientes: (await costosIngredientes()).lista }); }
  catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});

app.get(`/productos/${CLAVE_CONECTOR}`, async (_req, res) => {
  cors(res);
  try { res.json({ ok: true, productos: await productosFudo() }); }
  catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});

app.listen(PORT, () => console.log(`Conector Fudo escuchando en el puerto ${PORT}`));
