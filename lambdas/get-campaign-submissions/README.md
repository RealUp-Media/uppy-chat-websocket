# Lambda: Get Campaign Submissions

Lambda para obtener las entregas (inputs y uploads) de influencers por campaña y paso, con URLs presignadas para acceder a los archivos en S3.

## Descripción

Consulta la tabla `uppy_chat_messages` para obtener los mensajes con `message_type = 'user_step_submission'` (inputs de texto y archivos subidos por influencers en pasos del flujo). Para cada archivo adjunto, genera una URL presignada de S3 que permite descargar o visualizar el archivo sin exponer credenciales.

## Request

### campaign_id (requerido)

Se puede enviar de tres formas:

1. **Path parameter** (API Gateway): `GET /campaigns/{campaign_id}/submissions`
2. **Query string**: `?campaign_id=huggies-co-2025-01`
3. **Body** (POST): `{ "campaign_id": "huggies-co-2025-01" }`

### step_id (opcional)

Filtrar por paso específico (ej: `ASK_CONTENT_LINK`, `ASK_EVIDENCE`).

### limit (opcional)

Límite de resultados (default: 200, máx: 500).

### disposition (opcional)

- `inline` (default): Las URLs permiten ver imágenes/videos directamente en el navegador.
- `attachment`: Las URLs fuerzan la descarga del archivo.

## Response

### Éxito (200)

```json
{
  "campaign_id": "huggies-co-2025-01",
  "step_id": null,
  "submissions": [
    {
      "message_id": "uuid",
      "enrollment_id": "enr-xxx",
      "sender_id": "sub-cognito",
      "sender_username": "influencer1",
      "message_text": "https://instagram.com/p/abc123",
      "step_id": "ASK_CONTENT_LINK",
      "campaign_id": "huggies-co-2025-01",
      "created_at": "2025-03-13T10:00:00.000Z",
      "attachments": []
    },
    {
      "message_id": "uuid",
      "enrollment_id": "enr-yyy",
      "sender_username": "influencer2",
      "message_text": null,
      "step_id": "ASK_EVIDENCE",
      "created_at": "2025-03-13T11:00:00.000Z",
      "attachments": [
        {
          "s3Key": "chat-files/enr-yyy/uuid.png",
          "url": "s3://bucket/chat-files/...",
          "fileName": "screenshot.png",
          "fileSize": 12345,
          "mimeType": "image/png",
          "presigned_url": "https://bucket.s3.region.amazonaws.com/...?X-Amz-..."
        }
      ]
    }
  ],
  "count": 2
}
```

Las URLs presignadas expiran en 1 hora por defecto (configurable con `PRESIGNED_URL_EXPIRY_SECONDS`).

## Variables de Entorno

- `AWS_REGION`: Región de AWS (default: `us-east-1`)
- `MESSAGES_TABLE_NAME`: Tabla DynamoDB de mensajes (default: `uppy_chat_messages`)
- `CHAT_FILES_BUCKET`: Bucket S3 donde están los archivos del chat (default: `uppy-campaign-messages` o `CAMPAIGN_MESSAGES_BUCKET`)
- `PRESIGNED_URL_EXPIRY_SECONDS`: Expiración de URLs presignadas en segundos (default: 3600)

## Permisos IAM Requeridos

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["dynamodb:Scan"],
      "Resource": "arn:aws:dynamodb:REGION:ACCOUNT_ID:table/uppy_chat_messages"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject"],
      "Resource": "arn:aws:s3:::uppy-campaign-messages/chat-files/*"
    }
  ]
}
```

## Invocación

### Desde API Gateway

```bash
curl -X GET "https://your-api-gateway-url/campaigns/huggies-co-2025-01/submissions"
curl -X GET "https://your-api-gateway-url/campaigns/huggies-co-2025-01/submissions?step_id=ASK_EVIDENCE&limit=50"
```

### Invocación Directa (SDK)

```python
import boto3
import json

lambda_client = boto3.client('lambda')
response = lambda_client.invoke(
    FunctionName='get-campaign-submissions',
    InvocationType='RequestResponse',
    Payload=json.dumps({
        "campaign_id": "huggies-co-2025-01",
        "step_id": "ASK_CONTENT_LINK"
    })
)
result = json.loads(response['Payload'].read())
data = json.loads(result['body'])
print(data['submissions'])
```
