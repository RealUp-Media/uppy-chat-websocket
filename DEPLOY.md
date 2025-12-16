# 🚀 Guía de Despliegue

## Opción 1: Railway (RECOMENDADO - Más fácil y rápido)

Railway es perfecto para aplicaciones con WebSockets como la tuya.

### Pasos:

1. **Crear cuenta en Railway**
   - Ve a https://railway.app
   - Regístrate con GitHub (más fácil)

2. **Conectar tu repositorio**
   - Click en "New Project"
   - Selecciona "Deploy from GitHub repo"
   - Elige tu repositorio

3. **Configurar variables de entorno**
   - En Railway, ve a tu proyecto → Variables
   - Agrega todas las variables que necesitas (PORT, CORS_ORIGIN, AWS credentials, etc.)
   - Railway automáticamente detectará el puerto, pero puedes configurar PORT si quieres

4. **¡Listo!**
   - Railway detectará automáticamente que es Node.js
   - Desplegará tu aplicación
   - Te dará una URL como: `tu-app.up.railway.app`

### Ventajas de Railway:
- ✅ Soporta WebSockets perfectamente
- ✅ Plan gratuito generoso ($5 gratis al mes)
- ✅ Despliegue automático desde GitHub
- ✅ Muy fácil de usar
- ✅ HTTPS automático

---

## Opción 2: Render (Alternativa gratuita)

### Pasos:

1. Ve a https://render.com
2. Crea una cuenta
3. Click en "New" → "Web Service"
4. Conecta tu repositorio de GitHub
5. Configura:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Environment**: Node
6. Agrega tus variables de entorno
7. Click en "Create Web Service"

### Nota sobre Render:
- Plan gratuito tiene limitaciones (se duerme después de 15 min de inactividad)
- Soporta WebSockets pero con algunas limitaciones

---

## Opción 3: Fly.io (Buena para WebSockets)

### Pasos:

1. Instala Fly CLI: `curl -L https://fly.io/install.sh | sh`
2. Login: `fly auth login`
3. Crea la app: `fly launch`
4. Despliega: `fly deploy`

### Ventajas:
- ✅ Excelente soporte para WebSockets
- ✅ Plan gratuito generoso
- ✅ Muy rápido

---

## Variables de Entorno Necesarias

Asegúrate de configurar estas variables en tu plataforma:

```env
PORT=3000
CORS_ORIGIN=https://tu-frontend.com
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=tu-access-key
AWS_SECRET_ACCESS_KEY=tu-secret-key
# ... otras variables que uses
```

---

## Recomendación Final

**Usa Railway** - Es la opción más sencilla y rápida para tu caso. Solo conecta GitHub y listo.

