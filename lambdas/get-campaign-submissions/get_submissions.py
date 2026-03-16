"""
Lambda: Get Campaign Submissions

Obtiene las entregas (inputs y uploads) de influencers por campaña y paso.
Para cada archivo adjunto, genera URLs presignadas de S3 para poder revisarlos.
"""

import json
import os
import boto3
import logging
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(logging.INFO)

dynamodb = boto3.resource(
    'dynamodb',
    region_name=os.environ.get('AWS_REGION', 'us-east-1')
)

s3_client = boto3.client(
    's3',
    region_name=os.environ.get('AWS_REGION', 'us-east-1')
)

MESSAGES_TABLE = os.environ.get('MESSAGES_TABLE_NAME', 'uppy_chat_messages')
CHAT_FILES_BUCKET = os.environ.get('CHAT_FILES_BUCKET', os.environ.get('CAMPAIGN_MESSAGES_BUCKET', 'uppy-campaign-messages'))
PRESIGNED_URL_EXPIRY = int(os.environ.get('PRESIGNED_URL_EXPIRY_SECONDS', 3600))


def _generate_presigned_url(s3_key, filename=None, inline=True):
    """
    Genera una URL presignada para un archivo de S3.
    inline=True: el navegador muestra el archivo (imágenes, videos).
    inline=False: el navegador descarga el archivo.
    """
    try:
        params = {
            'Bucket': CHAT_FILES_BUCKET,
            'Key': s3_key
        }
        if filename:
            disposition = 'inline' if inline else 'attachment'
            params['ResponseContentDisposition'] = f'{disposition}; filename="{filename}"'

        url = s3_client.generate_presigned_url(
            'get_object',
            Params=params,
            ExpiresIn=PRESIGNED_URL_EXPIRY
        )
        return url
    except ClientError as e:
        logger.warning(f"Error generando presigned URL para {s3_key}: {e}")
        return None


def get_submissions(campaign_id, step_id=None, limit=200, inline=True):
    """
    Obtiene las entregas de influencers desde DynamoDB y añade URLs presignadas
    para los archivos en S3.

    Returns:
        list: Lista de entregas con message_text, attachments (con presigned_url), etc.
    """
    table = dynamodb.Table(MESSAGES_TABLE)

    filter_expr = "campaign_id = :cid AND message_type = :mt"
    expr_values = {':cid': campaign_id, ':mt': 'user_step_submission'}

    if step_id:
        filter_expr += " AND step_id = :sid"
        expr_values[':sid'] = step_id

    try:
        response = table.scan(
            FilterExpression=filter_expr,
            ExpressionAttributeValues=expr_values,
            Limit=limit
        )
        items = response.get('Items', [])

        # Paginar si hay más resultados
        while 'LastEvaluatedKey' in response:
            response = table.scan(
                FilterExpression=filter_expr,
                ExpressionAttributeValues=expr_values,
                Limit=limit,
                ExclusiveStartKey=response['LastEvaluatedKey']
            )
            items.extend(response.get('Items', []))
            if len(items) >= limit:
                break

        # Ordenar por created_at descendente
        items.sort(key=lambda x: x.get('created_at', ''), reverse=True)

        # Enriquecer attachments con presigned URLs
        result = []
        for item in items[:limit]:
            entry = {
                'message_id': item.get('message_id'),
                'enrollment_id': item.get('conversation_id'),
                'sender_id': item.get('sender_id'),
                'sender_username': item.get('sender_username'),
                'message_text': item.get('message_text'),
                'step_id': item.get('step_id'),
                'campaign_id': item.get('campaign_id'),
                'created_at': item.get('created_at')
            }

            attachments = item.get('attachments') or []
            enriched_attachments = []
            for att in attachments:
                s3_key = att.get('s3Key')
                if not s3_key:
                    enriched_attachments.append(att)
                    continue

                presigned_url = _generate_presigned_url(
                    s3_key,
                    att.get('fileName'),
                    inline=inline
                )
                enriched_attachments.append({
                    **att,
                    'presigned_url': presigned_url
                })
            entry['attachments'] = enriched_attachments

            result.append(entry)

        return result

    except ClientError as e:
        logger.error(f"Error escaneando DynamoDB: {e}")
        raise


def _extract_params(event):
    """Extrae campaign_id y step_id del event (API Gateway o invocación directa)."""
    path_params = event.get('pathParameters') or {}
    qs = event.get('queryStringParameters') or {}

    campaign_id = (
        path_params.get('campaign_id') or path_params.get('campaignId') or
        qs.get('campaign_id') or qs.get('campaignId')
    )

    step_id = (
        path_params.get('step_id') or path_params.get('stepId') or
        qs.get('step_id') or qs.get('stepId')
    )

    body = {}
    if not campaign_id:
        raw_body = event.get('body')
        if isinstance(raw_body, str):
            try:
                body = json.loads(raw_body) if raw_body else {}
            except json.JSONDecodeError:
                body = {}
        body = body or {}
        campaign_id = body.get('campaign_id') or body.get('campaignId')
        step_id = step_id or body.get('step_id') or body.get('stepId')

    limit = 200
    if qs.get('limit'):
        try:
            limit = min(int(qs['limit']), 500)
        except ValueError:
            pass

    # disposition=inline (default) para ver en navegador, attachment para descargar
    disp = qs.get('disposition') or body.get('disposition', 'inline')
    inline = str(disp).lower() != 'attachment'

    return campaign_id, step_id, limit, inline


def lambda_handler(event, context):
    """
    Obtiene las entregas de influencers con URLs presignadas para archivos en S3.

    Event (API Gateway GET /campaigns/{campaign_id}/submissions):
        pathParameters: { "campaign_id": "..." }
        queryStringParameters: { "step_id": "...", "limit": "100" }
    O body: { "campaign_id": "...", "step_id": "..." }

    Returns:
        {
            "statusCode": 200,
            "body": {
                "campaign_id": "...",
                "step_id": null,
                "submissions": [...],
                "count": N
            }
        }
    """
    try:
        logger.info("🚀 Lambda get-campaign-submissions iniciada")

        campaign_id, step_id, limit, inline = _extract_params(event)

        if not campaign_id:
            return {
                'statusCode': 400,
                'headers': {'Content-Type': 'application/json'},
                'body': json.dumps({
                    'error': 'Bad request',
                    'message': 'campaign_id is required (path, query, or body)'
                })
            }

        submissions = get_submissions(campaign_id, step_id or None, limit, inline=inline)

        return {
            'statusCode': 200,
            'headers': {'Content-Type': 'application/json'},
            'body': json.dumps({
                'campaign_id': campaign_id,
                'step_id': step_id,
                'submissions': submissions,
                'count': len(submissions)
            }, default=str)
        }

    except Exception as e:
        logger.exception(f"❌ Error inesperado: {e}")
        return {
            'statusCode': 500,
            'headers': {'Content-Type': 'application/json'},
            'body': json.dumps({
                'error': 'Internal server error',
                'message': str(e)
            })
        }
