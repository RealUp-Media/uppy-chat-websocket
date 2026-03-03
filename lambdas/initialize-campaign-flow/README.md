# Lambda: Initialize Campaign Flow

Esta Lambda inicializa el flujo de campaña para un enrollment específico, guardando el mensaje inicial en la tabla de mensajes para que aparezca cuando el influencer se conecte al WebSocket.

## 📋 Propósito

Cuando se crea un nuevo enrollment o se quiere iniciar el flujo de campaña para un influencer, esta Lambda:

1. Obtiene el enrollment y el flujo de campaña
2. Obtiene el paso inicial del flujo (order: 1)
3. Carga el mensaje desde S3
4. Actualiza el enrollment con `current_step_id` al paso inicial
5. Guarda el mensaje inicial en `uppy_chat_messages` con los botones correspondientes

## 🔧 Configuración

### Variables de Entorno

- `AWS_REGION`: Región de AWS (default: `us-east-1`)
- `ENROLLMENT_TABLE_NAME`: Nombre de la tabla de enrollments (default: `uppy_enrollment`)
- `CAMPAIGN_FLOW_TABLE_NAME`: Nombre de la tabla de flujos (default: `uppy_campaign_flow`)
- `MESSAGES_TABLE_NAME`: Nombre de la tabla de mensajes (default: `uppy_chat_messages`)
- `CAMPAIGN_MESSAGES_BUCKET`: Nombre del bucket S3 para mensajes (default: `uppy-campaign-messages`)

### Permisos IAM Requeridos

La Lambda necesita permisos para:

- **DynamoDB**:
  - `dynamodb:Query` en `uppy_enrollment` (GSI: `enrollment-id-index`)
  - `dynamodb:Scan` en `uppy_enrollment` (fallback)
  - `dynamodb:GetItem` en `uppy_campaign_flow`
  - `dynamodb:PutItem` en `uppy_enrollment` y `uppy_chat_messages`

- **S3**:
  - `s3:GetObject` en `uppy-campaign-messages`

## 📥 Input

### Desde API Gateway

```json
{
  "enrollment_id": "uuid-del-enrollment",
  "campaign_id": "maxlit-2024-diciembre"  // Opcional, se obtiene del enrollment si no se proporciona
}
```

### Invocación Directa

```json
{
  "enrollment_id": "uuid-del-enrollment",
  "campaign_id": "maxlit-2024-diciembre"
}
```

## 📤 Output

### Éxito (200)

```json
{
  "statusCode": 200,
  "body": {
    "message": "Flow initialized successfully",
    "enrollment_id": "uuid-del-enrollment",
    "step_id": "WELCOME_MESSAGE",
    "message_id": "uuid-del-mensaje"
  }
}
```

### Errores

- **400**: `enrollment_id` o `campaign_id` faltante
- **404**: Enrollment, flujo o mensaje no encontrado
- **500**: Error interno del servidor

## 🚀 Uso

### Desde AWS CLI

```bash
aws lambda invoke \
  --function-name initialize-campaign-flow \
  --payload '{
    "enrollment_id": "uuid-del-enrollment",
    "campaign_id": "maxlit-2024-diciembre"
  }' \
  response.json

cat response.json
```

### Desde API Gateway

```bash
curl -X POST https://your-api.execute-api.us-east-1.amazonaws.com/initialize-flow \
  -H "Content-Type: application/json" \
  -d '{
    "enrollment_id": "uuid-del-enrollment",
    "campaign_id": "maxlit-2024-diciembre"
  }'
```

## 🔄 Flujo de Trabajo

1. **Lambda recibe request** con `enrollment_id`
2. **Obtiene enrollment** de DynamoDB usando GSI `enrollment-id-index`
3. **Obtiene campaign_id** del enrollment (o del input)
4. **Obtiene flujo** de `uppy_campaign_flow` usando `id_campaign`
5. **Encuentra paso inicial** (order: 1)
6. **Carga mensaje** desde S3 usando `ui_message_s3_key`
7. **Actualiza enrollment** con `current_step_id = step_id` del paso inicial
8. **Guarda mensaje** en `uppy_chat_messages` con:
   - `message_type: "campaign_flow_step"`
   - `step_id`: ID del paso
   - `buttons`: Array con botones "accept" y "reject"
   - `sender_type: "system"`

## 📝 Estructura del Mensaje Guardado

El mensaje se guarda en `uppy_chat_messages` con esta estructura:

```json
{
  "message_id": "uuid",
  "conversation_id": "enrollment_id",
  "sender_id": "system",
  "sender_type": "system",
  "sender_username": "Sistema",
  "message_text": "Hola [Nombre] 👋...",
  "message_type": "campaign_flow_step",
  "step_id": "WELCOME_MESSAGE",
  "campaign_id": "maxlit-2024-diciembre",
  "buttons": [
    {
      "id": "accept",
      "label": "Aceptar",
      "action": "accept"
    },
    {
      "id": "reject",
      "label": "Rechazar",
      "action": "reject"
    }
  ],
  "created_at": "2025-01-13T..."
}
```

## 🔗 Integración con WebSocket

Cuando el influencer se conecta al WebSocket:

1. El servidor carga el historial de mensajes con `getConversationHistory(enrollment_id)`
2. El mensaje inicial aparece con los botones
3. Al hacer clic en un botón, el frontend emite `flow_action` con `action_id: "accept"` o `"reject"`
4. El servidor procesa la transición y actualiza el enrollment al siguiente paso

## ⚠️ Notas Importantes

- El enrollment debe existir y tener `id_campaign`
- El flujo de campaña debe existir y tener al menos un paso
- El paso inicial debe tener `ui_message_s3_key` configurado
- El mensaje en S3 debe tener la estructura correcta con `text`, `accept_button_label`, `reject_button_label`

## 🧪 Testing

Ver `example_initialize_request.json` para un ejemplo de request.
