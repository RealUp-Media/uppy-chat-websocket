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

# Autenticación (opcional para pruebas)
DISABLE_AUTH=true  # Establece a 'true' para deshabilitar autenticación JWT durante pruebas

# Configuración de User Pools de Cognito
# Opción 1: User pools separados (recomendado para producción)
COGNITO_USER_POOL_ID_INFLUENCERS=us-east-1_XXXXX  # User pool para influencers
COGNITO_USER_POOL_ID_OPERATIONS=us-east-1_YYYYY   # User pool para operations

# Opción 2: User pool único (compatibilidad con configuración anterior)
COGNITO_USER_POOL_ID=us-east-1_ZZZZZ  # User pool por defecto (se usa si no hay pools específicos)

# Configuración de Lambdas (invocación directa por ARN)
LAMBDA_FUNCTION_BEDROCK_AI=uppy_websocket_ai_response
# LAMBDA_FUNCTION_EXAMPLE=example-lambda  # Para futuras lambdas
```

### 🔐 Configuración de Múltiples User Pools

El backend soporta múltiples user pools de Cognito para separar usuarios de influencers y operations:

**Configuración recomendada (User pools separados):**

- `COGNITO_USER_POOL_ID_INFLUENCERS`: User pool para usuarios influencers
- `COGNITO_USER_POOL_ID_OPERATIONS`: User pool para usuarios de operations

El middleware intentará verificar el token con cada user pool hasta encontrar uno válido. El rol del usuario se determina automáticamente según el user pool que validó el token:

- Si el token viene del user pool de influencers → rol: `influencer`
- Si el token viene del user pool de operations → rol: `operations`

**Configuración legacy (User pool único):**
Si solo configuras `COGNITO_USER_POOL_ID`, el sistema funcionará como antes, determinando el rol desde los grupos de Cognito (`influencer` o `operations`).

### 🔓 Modo de Pruebas (Sin Autenticación)

Para hacer pruebas sin autenticación, establece `DISABLE_AUTH=true`. El servidor creará automáticamente un usuario de prueba con:

- Role: `operations`
- Email: `test@example.com`
- Username: `test-user`

**⚠️ IMPORTANTE**: No uses `DISABLE_AUTH=true` en producción.

### 🤖 Integración con Lambdas (Bedrock AI)

El backend puede generar respuestas automáticas con IA cuando un influencer envía un mensaje. Para habilitar esta funcionalidad:

1. **Despliega la lambda de Bedrock** (ver `lambdas/bedrock-ai-response/README.md`)
2. **Configura el nombre de la función Lambda**:
   ```env
   LAMBDA_FUNCTION_BEDROCK_AI=uppy_websocket_ai_response
   ```

**Permisos IAM requeridos:**
El backend necesita permisos para invocar lambdas:

```json
{
  "Effect": "Allow",
  "Action": "lambda:InvokeFunction",
  "Resource": "arn:aws:lambda:us-east-1:ACCOUNT_ID:function:uppy_websocket_ai_response"
}
```

**Flujo de respuestas automáticas:**

- Cuando un influencer envía un mensaje, el sistema automáticamente:
  1. Guarda el mensaje del influencer
  2. Obtiene el historial de conversación
  3. Invoca la lambda de Bedrock directamente por ARN
  4. Genera una respuesta contextual con IA
  5. Guarda y envía la respuesta automática

Las respuestas de IA se guardan con `sender_type: 'ai'` y `sender_id: 'ai-assistant'`.

## 📚 Documentación

- [WEBSOCKET_CLIENT_GUIDE.md](./WEBSOCKET_CLIENT_GUIDE.md)
- [WEBSOCKET_OPERATIONS_INTERFACE.md](./WEBSOCKET_OPERATIONS_INTERFACE.md)
- [WEBSOCKET_PROMPT_FRONTEND.md](./WEBSOCKET_PROMPT_FRONTEND.md)
