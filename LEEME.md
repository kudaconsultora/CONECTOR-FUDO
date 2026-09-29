# Conector Fudo para Claude — Mandy's

Permite que Claude lea ventas, gastos y productos de Fudo. **Es solo de lectura: no cambia nada en Fudo.**

## 1. Sacar las claves en Fudo (lo hace Euge)

1. En Fudo: **Administración > Usuarios** → crear un usuario nuevo, por ejemplo `api@mandys`, con permiso para ver ventas, gastos y productos.
2. Editar ese usuario → copiar la **API Key**.
3. Tocar **Establecer** → copiar la **API Secret** (se ve una sola vez, guardarla bien).

## 2. Subirlo al servidor (para la programadora)

- Es una app **Node.js 18 o más nueva** (Express + MCP SDK). Necesita **HTTPS**.
- Instalar y arrancar: `npm install` y después `npm start`.
- Cargar estas variables de entorno (nunca en el código):

| Variable | Qué va |
|---|---|
| `FUDO_API_KEY` | La API Key de Fudo |
| `FUDO_API_SECRET` | La API Secret de Fudo |
| `CLAVE_CONECTOR` | Una clave larga inventada, solo letras y números (ej. 40 caracteres) |
| `PORT` | Opcional; muchos hostings lo ponen solos |

- Para probar: abrir `https://SU-DOMINIO/` tiene que decir "Conector Fudo de Mandy's funcionando ✔".

**Si no hay hosting propio:** sirve igual en **Render.com** (gratis): New → Web Service → subir esta carpeta a GitHub → Build `npm install`, Start `npm start` → cargar las variables en "Environment".

## 3. Agregarlo en Claude (lo hace Euge)

En Claude: **Configuración > Conectores > Agregar conector personalizado**, y pegar esta dirección:

```
https://SU-DOMINIO/mcp/LA-CLAVE_CONECTOR
```

Esa dirección es como una contraseña: no compartirla.

## Direcciones para las herramientas (calculadora y gestor)

- Calculadora de compras → `https://SU-DOMINIO/costos/LA-CLAVE_CONECTOR`
- Gestor de precios → `https://SU-DOMINIO/productos/LA-CLAVE_CONECTOR`

## Cómo actualizar el conector (versión 2)

Reemplazar TODOS los archivos por los de este zip (hay dos nuevos: `control-precios.js` y `maestro.json`) y volver a desplegar. En Render: subir los cambios al repositorio de GitHub y se redespliega solo (o "Manual Deploy"). Las variables de entorno no cambian.

## Qué puede hacer Claude con esto

- **resumen_ventas**: totales por día, tipo, origen (apps, tienda) y medio de pago.
- **listar_ventas**: ventas una por una con su detalle.
- **resumen_gastos**: gastos por categoría y proveedor.
- **control_precios_congelados**: recalcula las listas del 0_MAESTRO con los costos de Fudo y avisa qué quedó atrasado.
- **control_precios_local**: avisa qué productos de la carta quedaron por debajo del precio mínimo.
- **consultar_fudo**: productos, ingredientes, costos, proveedores, clientes, descuentos.
