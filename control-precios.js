// Recalcula la hoja "4 PRECIOS" del 0_MAESTRO.xlsx usando los costos actuales de Fudo.
// Replica exactamente las fórmulas del Excel (recetas → costo por tanda → merma → costo por unidad
// → costo del paquete + envase → precio sugerido = costo / (1 - margen), redondeado hacia arriba a $50).
import { readFileSync } from "node:fs";

const MAESTRO = JSON.parse(readFileSync(new URL("./maestro.json", import.meta.url), "utf8"));
const UMBRAL = 0.05; // igual que el Excel: se avisa cuando la diferencia pasa el 5%

const redondeo = (n) => Math.round(n);
const techo50 = (n) => Math.ceil(n / 50) * 50;
const r10 = (n) => Math.round(n / 10) * 10;

// costosFudo: Map id_ingrediente -> costo (o null para calcular solo con los precios del Excel)
export function controlPrecios(costosFudo = null) {
  const M = MAESTRO;
  const precioIns = {};
  const cambiosInsumos = [];
  for (const [nombre, x] of Object.entries(M.insumos)) {
    let p = x.precio;
    const f = costosFudo && x.fudo_id ? costosFudo.get(String(x.fudo_id)) : null;
    if (f && f > 0) {
      const dif = x.precio ? (f - x.precio) / x.precio : 0;
      if (Math.abs(dif) >= 0.001) cambiosInsumos.push({ insumo: nombre, unidad: x.unidad, precio_excel: x.precio, precio_fudo: f, variacion: `${(dif * 100).toFixed(1)}%` });
      p = f;
    }
    precioIns[nombre] = p;
  }

  const costoUnidad = {};
  for (const [prod, rinde] of Object.entries(M.rinde)) {
    const tanda = (M.recetas[prod] || []).reduce((s, [ins, q]) => s + q * (precioIns[ins] || 0), 0);
    costoUnidad[prod] = (tanda * (1 + M.merma)) / rinde;
  }
  const envase = M.envase.reduce((s, n) => s + (precioIns[n] || 0), 0);

  const productos = M.productos.map((p) => {
    const costo = p.componentes.reduce((s, [c, n]) => s + n * (costoUnidad[c] || 0), 0) + envase;
    const sugerido = techo50(costo / (1 - p.margen));
    const lista = p.precio_lista;
    const diferencia = lista ? (lista - sugerido) / sugerido : null;
    return {
      producto: p.producto, presentacion: p.presentacion,
      costo: redondeo(costo), precio_sugerido: sugerido, precio_lista: lista,
      diferencia: diferencia === null ? null : `${(diferencia * 100).toFixed(1)}%`,
      atrasado: diferencia !== null && diferencia < -UMBRAL,
      paga_el_comercio_hoy: r10(lista * (1 + M.markup_vendedor)),
      paga_el_comercio_nuevo: r10(sugerido * (1 + M.markup_vendedor)),
    };
  });

  return {
    maestro_del: M.fecha_maestro,
    regla: "Se marca 'atrasado' cuando el precio de lista está más de 5% por debajo del sugerido (igual que la columna DIFERENCIA del Excel).",
    insumos_que_cambiaron_en_fudo: cambiosInsumos.sort((a, b) => parseFloat(b.variacion) - parseFloat(a.variacion)),
    insumos_sin_vincular_a_fudo: Object.entries(M.insumos).filter(([, x]) => !x.fudo_id && x.precio > 0).map(([n]) => n),
    productos_atrasados: productos.filter((p) => p.atrasado),
    todos_los_productos: productos,
  };
}
