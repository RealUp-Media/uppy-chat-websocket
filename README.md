# Backend App Influencers

Backend con WebSockets para aplicación de influencers usando Express, Socket.io y DynamoDB.

## 🚀 Despliegue Rápido

**Recomendación: Railway** - La opción más sencilla y rápida.

Ver [DEPLOY.md](./DEPLOY.md) para instrucciones detalladas de despliegue.

### Pasos rápidos para Railway:

1. Ve a https://railway.app y crea cuenta con GitHub
2. Click en "New Project" → "Deploy from GitHub repo"
3. Selecciona este repositorio
4. Agrega tus variables de entorno en Railway (Variables tab)
5. ¡Listo! Railway desplegará automáticamente

## 📦 Instalación Local

```bash
npm install
npm run dev
```

## 🔧 Variables de Entorno

Crea un archivo `.env` con:

```env
PORT=3000
CORS_ORIGIN=http://localhost:3000
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=tu-access-key
AWS_SECRET_ACCESS_KEY=tu-secret-key
```

## 📚 Documentación

- [WEBSOCKET_CLIENT_GUIDE.md](./WEBSOCKET_CLIENT_GUIDE.md)
- [WEBSOCKET_OPERATIONS_INTERFACE.md](./WEBSOCKET_OPERATIONS_INTERFACE.md)
- [WEBSOCKET_PROMPT_FRONTEND.md](./WEBSOCKET_PROMPT_FRONTEND.md)

