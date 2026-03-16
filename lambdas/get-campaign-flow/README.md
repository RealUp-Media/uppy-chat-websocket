# Lambda: Get Campaign Flow

Lambda para obtener la configuración del flujo de una campaña.

## Descripción

Obtiene el JSON completo de configuración de un flujo de campaña desde DynamoDB. Los mensajes UI almacenados en S3 (`ui_message_s3_key`) se cargan automáticamente y se incluyen en la respuesta como `ui_message`, de modo que el frontend recibe todo lo necesario para renderizar el flujo.

## Request

### Método

- **GET** (recomendado para consultas)
- **POST** (con body opcional)

### campaign_id

Se puede enviar de tres formas:

1. **Path parameter** (API Gateway): `GET /campaigns/{campaign_id}/flow`
2. **Query string**: `GET /campaigns/flow?campaign_id=huggies-co-2025-01`
3. **Body** (POST): `{ "campaign_id": "huggies-co-2025-01" }`

### Query params opcionales

- `load_messages=false`: Si se envía, no carga los `ui_message` desde S3 (solo retorna los datos raw de DynamoDB con `ui_message_s3_key`).

## Response

### Éxito (200)

```json
{
  "campaign_id": "huggies-co-2025-01",
  "id_campaign": "huggies-co-2025-01",
  "steps": [
    {
      "step_id": "ACCEPT_CAMPAIGN",
      "order": 1,
      "type": "ACTION_BUTTONS",
      "ui_message": {
        "text": "¿Aceptas participar en esta campaña?",
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
    }
  ],
  "created_at": "2025-01-05T10:00:00",
  "updated_at": "2025-01-05T10:00:00"
}
```

### No encontrado (404)

```json
{
  "error": "Not found",
  "message": "Campaign flow not found for campaign_id: xxx"
}
```

### Error (400/500)

```json
{
  "error": "Error description",
  "message": "Detailed error message"
}
```

## Variables de Entorno

- `AWS_REGION`: Región de AWS (default: `us-east-1`)
- `CAMPAIGN_FLOW_TABLE_NAME`: Tabla DynamoDB (default: `uppy_campaign_flow`)
- `CAMPAIGN_MESSAGES_BUCKET`: Bucket S3 para mensajes (default: `uppy-campaign-messages`)

## Permisos IAM Requeridos

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["dynamodb:GetItem"],
      "Resource": "arn:aws:dynamodb:REGION:ACCOUNT_ID:table/uppy_campaign_flow"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject"],
      "Resource": "arn:aws:s3:::uppy-campaign-messages/campaign-flows/*"
    }
  ]
}
```

## Invocación

### Desde API Gateway

```bash
curl -X GET "https://your-api-gateway-url/campaigns/huggies-co-2025-01/flow"
```

### Invocación Directa (SDK)

```python
import boto3
import json

lambda_client = boto3.client('lambda')
response = lambda_client.invoke(
    FunctionName='get-campaign-flow',
    InvocationType='RequestResponse',
    Payload=json.dumps({
        "campaign_id": "huggies-co-2025-01"
    })
)
result = json.loads(response['Payload'].read())
flow = json.loads(result['body']) if isinstance(result.get('body'), str) else result.get('body')
```
