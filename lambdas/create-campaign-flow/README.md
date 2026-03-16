# Lambda: Create Campaign Flow

Lambda para crear o actualizar flujos de campaña en DynamoDB.

## Descripción

Esta lambda permite crear y configurar flujos de campaña que definen los pasos que un influencer debe seguir durante una campaña. Los flujos se almacenan en la tabla `uppy_campaign_flow` de DynamoDB.

## Estructura de Datos

### Request Body

**Importante**: Los mensajes `ui_message` pueden ser de cualquier tamaño. La lambda los sube automáticamente a S3 y los reemplaza con `ui_message_s3_key` en DynamoDB.

```json
{
  "campaign_id": "huggies-co-2025-01",
  "steps": [
    {
      "step_id": "ACCEPT_CAMPAIGN",
      "order": 1,
      "type": "ACTION_BUTTONS",
      "ui_message": {
        "text": "¿Aceptas participar en esta campaña? Este mensaje puede ser muy largo y se guardará en S3...",
        "buttons": [
          { "id": "ACCEPT", "label": "✅ Sí, acepto" },
          { "id": "REJECT", "label": "❌ No acepto" }
        ]
      },
      "transitions": {
        "ACCEPT": "ASK_CONTENT_LINK",
        "REJECT": "REJECTED"
      },
      "repeatable": false
    },
    {
      "step_id": "ASK_CONTENT_LINK",
      "order": 2,
      "type": "INPUT_URL",
      "ui_message": {
        "text": "Comparte el link de tu contenido publicado"
      },
      "on_complete": "ASK_EVIDENCE",
      "repeatable": true
    },
    {
      "step_id": "ASK_EVIDENCE",
      "order": 3,
      "type": "UPLOAD_FILES",
      "ui_message": {
        "text": "Sube tus evidencias (screenshots o videos)"
      },
      "on_complete": "FINAL_CONFIRMATION",
      "repeatable": true
    },
    {
      "step_id": "FINAL_CONFIRMATION",
      "order": 4,
      "type": "ACTION_BUTTONS",
      "ui_message": {
        "text": "¿Confirmas que la información enviada es correcta?",
        "buttons": [
          { "id": "CONFIRM", "label": "✅ Confirmo" },
          { "id": "EDIT", "label": "✏️ Necesito corregir algo" }
        ]
      },
      "transitions": {
        "CONFIRM": "COMPLETED",
        "EDIT": "ASK_CONTENT_LINK"
      },
      "repeatable": true
    }
  ]
}
```

### Tipos de Pasos

1. **ACTION_BUTTONS**: Paso con botones de acción

   - Requiere: `transitions` (objeto con mapeo button_id -> step_id)
   - Requiere: `ui_message.buttons` (array de botones)

2. **INPUT_URL**: Paso para ingresar URL

   - Requiere: `on_complete` (step_id del siguiente paso)

3. **UPLOAD_FILES**: Paso para subir archivos
   - Requiere: `on_complete` (step_id del siguiente paso)

4. **upload** (paso tipo upload): Subir contenido multimedia (foto, video o ambos)
   - Requiere: `transitions.submit` (step_id del siguiente paso)
   - `allowed_types`: `"image"` | `"video"` | `"both"` — qué tipo de archivo aceptar
   - `submit_button_label`: (opcional, default "Enviar")
   - Ejemplo: ver `example_upload_step.json`

### Validaciones

- Todos los pasos deben tener `step_id` único
- Todos los pasos deben tener `order` único (números enteros positivos)
- Las transiciones deben apuntar a `step_id` válidos
- Los `on_complete` deben apuntar a `step_id` válidos

## Despliegue

### Requisitos

- Python 3.9+
- boto3 (incluido en el runtime de Lambda)

### Variables de Entorno

- `AWS_REGION`: Región de AWS (default: `us-east-1`)
- `CAMPAIGN_FLOW_TABLE_NAME`: Nombre de la tabla DynamoDB (default: `uppy_campaign_flow`)
- `CAMPAIGN_MESSAGES_BUCKET`: Nombre del bucket S3 para mensajes (default: `uppy-campaign-messages`)

**Nota**: Los mensajes `ui_message` se suben automáticamente a S3 y se reemplazan con `ui_message_s3_key` en DynamoDB. Esto permite mensajes de cualquier tamaño sin límites de DynamoDB.

### Permisos IAM Requeridos

La lambda necesita permisos para escribir en DynamoDB y S3:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["dynamodb:PutItem", "dynamodb:GetItem"],
      "Resource": "arn:aws:dynamodb:REGION:ACCOUNT_ID:table/uppy_campaign_flow"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject"],
      "Resource": "arn:aws:s3:::uppy-campaign-messages/campaign-flows/*"
    }
  ]
}
```

### Invocación

#### Desde API Gateway (POST)

```bash
curl -X POST https://your-api-gateway-url/flows \
  -H "Content-Type: application/json" \
  -d '{
    "campaign_id": "huggies-co-2025-01",
    "steps": [...]
  }'
```

#### Invocación Directa (SDK)

```python
import boto3

lambda_client = boto3.client('lambda')
response = lambda_client.invoke(
    FunctionName='create-campaign-flow',
    InvocationType='RequestResponse',
    Payload=json.dumps({
        "campaign_id": "huggies-co-2025-01",
        "steps": [...]
    })
)
```

## Respuesta

### Éxito (200)

**Nota**: Los `ui_message` se reemplazan con `ui_message_s3_key` en la respuesta:

```json
{
  "campaign_id": "huggies-co-2025-01",
  "steps": [
    {
      "step_id": "ACCEPT_CAMPAIGN",
      "order": 1,
      "type": "ACTION_BUTTONS",
      "ui_message_s3_key": "campaign-flows/huggies-co-2025-01/steps/ACCEPT_CAMPAIGN/message.json",
      "transitions": {...},
      "repeatable": false
    }
  ],
  "created_at": "2025-01-05T10:00:00",
  "updated_at": "2025-01-05T10:00:00"
}
```

El backend carga automáticamente los mensajes desde S3 cuando se obtiene el flujo.

### Error (400/500)

```json
{
  "error": "Error description",
  "message": "Detailed error message"
}
```
