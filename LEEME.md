# Checador Packatelas (web, sin servidor y sin APK)

Dos páginas en el mismo GitHub Pages:

| Página | Dónde se abre | Para qué |
|---|---|---|
| `kiosco.html` | En la tablet o celular que se queda en la base | Muestra el QR, toma la foto, confirma la checada |
| `index.html` | En el celular de cada empleado (al escanear el QR) | Pone su huella |

Nadie instala nada. Para cambiar algo, se suben los archivos nuevos a GitHub.

## Cómo funciona
1. El kiosco muestra un QR que cambia cada 20 s.
2. El empleado lo escanea, toca **Checar con huella** y pone su dedo.
3. El kiosco verifica la firma de su celular, le toma foto y muestra la checada que le toca
   (Entrada, Salir a comer, Regresar de comer o Salida). Si no es la correcta, la cambia ahí mismo.
4. La checada llega a la hoja de Google y la foto a Drive (enlace en la columna Foto).

Los empleados y las llaves de sus celulares viven en la pestaña **Empleados** de la hoja, así que
no se pierden si se borra el navegador o cambias de dispositivo.

## Publicar / actualizar
Sube TODOS estos archivos al repositorio `checador` (reemplazando los anteriores):
`index.html, app.js, estilo.css, qrcode.js, sw.js, verif.js, kiosco.html, kiosco.js, kiosco.css,
kiosco.webmanifest, icono-192.png, icono-512.png`

## Primera vez en el dispositivo del kiosco (iPhone / iPad con Chrome)
1. Abre en Chrome `https://TU-USUARIO.github.io/checador/kiosco.html`.
2. Toca **Compartir** (cuadro con flecha) → **Agregar a pantalla de inicio**.
3. Abre el checador **desde ese ícono** (así se ve sin barras). Te pide la configuración:
   URL `/exec` de Apps Script, token, ID del kiosco, nombre y PIN. Permite la **cámara**.
4. Ajustes → Pantalla y brillo → **Bloqueo automático: Nunca**.
5. Ajustes → Accesibilidad → **Acceso guiado** → actívalo con un código. Con el checador abierto,
   presiona 3 veces el botón lateral → **Iniciar**. Así nadie puede salir del checador.
6. Toca la pantalla una vez al arrancar para activar el sonido de confirmación.

(En Android: menú ⋮ → Agregar a pantalla principal, y Ajustes → Seguridad → Fijar app.)

Para administrar después: **mantén presionado el reloj** 2 segundos → PIN.

## Empleados
- **+ Empleado** → número, nombre y sus checadas (atajos Oficina / Repartidor / Campo) →
  **Guardar y registrar celular** → el empleado escanea el QR con SU celular y pone su huella.
- ¿Venías de la app Android? En la app: Administración → Respaldo → **Exportar**. En el kiosco web:
  **Importar respaldo de la app**. Se conservan los celulares ya registrados.

## Conexión
Los celulares de los empleados usan el WiFi de la empresa. Si un celular no tiene conexión, la
página le pide conectarse al WiFi y volver a escanear. Si el kiosco se queda sin internet, guarda
las checadas que ya confirmó y las manda solas cuando regresa la conexión.

> No cambies la dirección de GitHub Pages: las huellas quedan ligadas a ella.
