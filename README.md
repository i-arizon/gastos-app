# Gastos

Aplicación web progresiva (PWA) para llevar el control de gastos personales, pensada para iPhone (Safari, iOS 17+) e instalable con **Compartir → Añadir a pantalla de inicio**. Funciona sin conexión y se sincroniza con una hoja de Google Sheets.

Hecha con HTML, CSS y JavaScript (módulos ES) sin framework ni paso de compilación. Los gráficos usan [Chart.js](https://www.chartjs.org/) 4.4.1 desde cdnjs.

## Cómo funciona

- **Datos locales (IndexedDB).** Gastos, categorías, ajustes y la cola de sincronización se guardan en el propio iPhone. Es la fuente de verdad: la app funciona completa sin conexión.
- **Modelo de gasto:** `id` (UUID), `date` (AAAA-MM-DD), `name`, `amount` (EUR), `category`, `tag` (etiqueta opcional, p. ej. «Viaje Lisboa»), `createdAt`, `updatedAt` (ISO) y `deleted`. Los borrados son lógicos (`deleted = true`) para que también se sincronicen.
- **Sincronización con Google Sheets.** Cada alta, edición o borrado se guarda primero en local, se añade a una cola y se envía al instante a un Apps Script publicado como aplicación web. Si falla (sin conexión, error), se reintenta al abrir la app, al recuperar la conexión, al volver a la app y cada 3 minutos. El indicador de la cabecera muestra *Sincronizado*, *N pendientes* o *Error*.
- **Restaurar.** En Ajustes, *Restaurar desde Google Sheets* descarga todos los gastos y los fusiona por `id`, quedándose con el `updatedAt` más reciente. Útil en un iPhone nuevo o tras borrar los datos de Safari.
- **Copia CSV.** Exportación (todo, un mes o un año) e importación en CSV con `;` y UTF-8 con BOM, que Excel en español abre directamente.
- **Offline y actualizaciones.** El service worker (`sw.js`) guarda en caché la app y Chart.js. Cuando se publica una versión nueva, la app se actualiza sola al abrirla, al cambiar de pestaña o al salir de ella, siempre que no estés escribiendo un gasto. Si lo estás, aparece el aviso *Hay una nueva versión disponible → Actualizar* y la actualización se aplica en cuanto termines.
- **Privacidad.** La URL del script y el token se introducen en Ajustes y se guardan solo en el dispositivo (IndexedDB). No están en el código, porque el repositorio es público.

## Pantallas

| Pestaña | Contenido |
|---|---|
| **Añadir** | Formulario rápido (concepto, importe con teclado numérico y coma decimal, fecha, categoría) y los últimos 10 gastos. El importe admite operaciones (`12,50+3,20`, `45÷3`) con la barra + − × ÷ que aparece bajo el campo. Las categorías más usadas en los últimos 90 días salen primero. Etiqueta opcional para agrupar gastos (viajes, eventos…). |
| **Gastos** | Todos los gastos agrupados por mes, con buscador y filtros por categoría y por etiqueta. Toca uno para editarlo, o deslízalo a la izquierda para *Editar* / *Eliminar*. Tira hacia abajo desde arriba del todo para sincronizar (envía lo pendiente y descarga los cambios de la hoja). |
| **Análisis** | *Mensual:* total y variación frente al mes anterior, donut y tabla por categoría, top 5 y gasto acumulado diario. *Anual:* total y media mensual, barras por mes, barras apiladas por categoría, tabla anual, evolución de las categorías que elijas y matriz mes × categoría. *Etiquetas:* total, nº de gastos y fechas de cada etiqueta; toca una para ver sus gastos. |
| **Ajustes** | Conexión con Google Sheets, sincronizar ahora, restaurar, gestión de categorías (añadir, cambiar color tocando la muestra, y deslizar a la izquierda para *Renombrar* o *Eliminar* con reasignación de sus gastos) y copia CSV. |

## Estructura

```
index.html          Estructura de la app y metatags PWA/iOS
styles.css          Estilos (mobile-first, modo claro/oscuro, safe areas)
app.js              Controlador: navegación, formularios, listas, ajustes
db.js               IndexedDB: gastos, categorías, cola y ajustes
sync.js             Sincronización con Apps Script (cola y reintentos)
charts.js           Cálculos y gráficos de Análisis
utils.js            Formato es-ES / EUR, fechas e importes
csv.js              Exportación e importación CSV
sw.js               Service worker (caché offline y versiones)
manifest.json       Manifiesto de la PWA
icons/              Iconos 180, 192 y 512 px
apps-script/Code.gs Código del Apps Script (Google Sheets)
tools/make_icons.py Generador de los iconos (Python, sin dependencias)
```

## Puesta en marcha

### 1. Google Sheet y Apps Script

1. Crea una hoja nueva en [sheets.new](https://sheets.new) y ponle nombre (p. ej. «Gastos»).
2. Menú **Extensiones → Apps Script**. Borra el contenido de `Código.gs` y pega el de [`apps-script/Code.gs`](apps-script/Code.gs). Guarda (icono del disquete).
3. **Token.** Opción A: en el desplegable de funciones elige `crearToken`, pulsa **Ejecutar**, acepta los permisos y copia el token del *Registro de ejecución*. Opción B: en **Configuración del proyecto (⚙) → Propiedades del script → Añadir propiedad**, crea `TOKEN` con un valor largo y aleatorio inventado por ti.
4. (Opcional) Ejecuta `setup` para crear ya la pestaña «Gastos» con las cabeceras.
5. **Implementar → Nueva implementación →** tipo **Aplicación web**. *Ejecutar como:* **Yo**. *Quién tiene acceso:* **Cualquier usuario**. Pulsa **Implementar**, autoriza y copia la **URL de la aplicación web** (termina en `/exec`).

> Si más adelante cambias el código del script: **Implementar → Gestionar implementaciones → ✏️ → Versión: Nueva versión → Implementar**. Así se mantiene la misma URL.

### 2. Instalar en el iPhone

1. Abre la URL pública de la app en **Safari**.
2. Pulsa **Compartir** (cuadrado con flecha) → **Añadir a pantalla de inicio** → **Añadir**.
3. Abre la app desde el icono «Gastos». La primera apertura con conexión deja la app lista para funcionar sin conexión.

### 3. Conectar la app con la hoja

1. En la app, ve a **Ajustes → Google Sheets**.
2. Pega la URL `/exec` y el token, y pulsa **Guardar**. Después **Probar conexión**: debe aparecer «Conexión correcta».
3. Añade un gasto de prueba en **Añadir**. El indicador pasará a *Sincronizado* y aparecerá una fila en la pestaña «Gastos» de la hoja. Puedes eliminarlo después; en la hoja quedará marcado `deleted = TRUE`.

### 4. Publicar cambios

1. Edita los archivos.
2. **Sube `VERSION` en `sw.js`** (p. ej. `1.0.0` → `1.0.1`). Sin esto los iPhone seguirán usando la versión en caché.
3. Prueba en local: `python -m http.server 8000` y abre <http://localhost:8000>.
4. Publica:
   ```bash
   git add -A
   git commit -m "Descripción del cambio"
   git push
   ```
5. GitHub Pages tarda 1–2 minutos. Al abrir la app en el iPhone se actualizará sola en unos segundos (verás «App actualizada · versión …»).

## Notas

- Los datos viven en el iPhone. Si borras los datos de Safari o desinstalas la app, usa **Restaurar desde Google Sheets** (o importa un CSV).
- Si se cambia un gasto en dos dispositivos, gana el cambio más reciente (`updatedAt`).
- La app envía el token siempre dentro del cuerpo de la petición (HTTPS), nunca en la URL, para que no quede en registros. Usa un token largo y no lo compartas. Si se filtra, cámbialo en Propiedades del script y en Ajustes.
- La app pide al navegador almacenamiento persistente para que iOS no borre los datos locales.
- Para regenerar los iconos: `python tools/make_icons.py`.
