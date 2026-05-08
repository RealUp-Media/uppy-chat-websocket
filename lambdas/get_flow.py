"""
Lambda: Get Campaign Flow

Obtiene la configuración completa del flujo de una campaña desde DynamoDB.
Carga los mensajes UI desde S3 cuando están almacenados allí (ui_message_s3_key).
Retorna el JSON de configuración listo para consumir desde el frontend.
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

TABLE_NAME = os.environ.get('CAMPAIGN_FLOW_TABLE_NAME', 'uppy_campaign_flow')
S3_BUCKET = os.environ.get('CAMPAIGN_MESSAGES_BUCKET', 'uppy-campaign-messages')


def _load_message_from_s3(s3_key):
    """Carga el mensaje UI desde S3."""
    try:
        response = s3_client.get_object(Bucket=S3_BUCKET, Key=s3_key)
        body = response['Body'].read().decode('utf-8')
        return json.loads(body)
    except ClientError as e:
        if e.response['Error']['Code'] == 'NoSuchKey':
            logger.warning(f"Mensaje no encontrado en S3: {s3_key}")
        else:
            logger.error(f"Error cargando mensaje de S3: {e}")
        return None
    except Exception as e:
        logger.error(f"Error procesando mensaje de S3: {e}")
        return None


def _load_flow_messages(steps):
    """Carga los ui_message para cada paso que tenga ui_message_s3_key."""
    if not steps or not isinstance(steps, list):
        return steps

    result = []
    for step in steps:
        step_copy = dict(step)
        if step_copy.get('ui_message'):
            # Ya tiene mensaje inline
            result.append(step_copy)
            continue
        if step_copy.get('ui_message_s3_key'):
            msg = _load_message_from_s3(step_copy['ui_message_s3_key'])
            if msg:
                step_copy['ui_message'] = msg
        result.append(step_copy)
    return result


def get_campaign_flow(campaign_id, load_messages=True):
    """
    Obtiene el flujo de campaña de DynamoDB.
    Si load_messages=True, reemplaza ui_message_s3_key con ui_message desde S3.

    Returns:
        dict: Flujo con campaign_id, steps, created_at, updated_at o None si no existe
    """
    try:
        table = dynamodb.Table(TABLE_NAME)
        response = table.get_item(Key={'id_campaign': campaign_id})

        if 'Item' not in response:
            return None

        flow = dict(response['Item'])

        if load_messages and flow.get('steps'):
            flow['steps'] = _load_flow_messages(flow['steps'])

        # Añadir campaign_id para consistencia en la API (la tabla usa id_campaign)
        flow['campaign_id'] = flow.get('id_campaign', campaign_id)

        return flow
    except Exception as e:
        logger.error(f"Error obteniendo flujo: {e}")
        raise


def _extract_campaign_id(event):
    """
    Extrae campaign_id del event.
    Soporta: pathParameters (API Gateway), queryStringParameters, body.
    """
    # API Gateway con path: /campaigns/{campaign_id}/flow
    path_params = event.get('pathParameters') or {}
    campaign_id = path_params.get('campaign_id') or path_params.get('campaignId')

    if not campaign_id:
        # Query string: ?campaign_id=xxx
        qs = event.get('queryStringParameters') or {}
        campaign_id = qs.get('campaign_id') or qs.get('campaignId')

    if not campaign_id:
        # Body (POST o invocación directa)
        body = event.get('body')
        if isinstance(body, str):
            try:
                body = json.loads(body) if body else {}
            except json.JSONDecodeError:
                body = {}
        body = body or {}
        campaign_id = body.get('campaign_id') or body.get('campaignId')

    return campaign_id


def lambda_handler(event, context):
    """
    Obtiene la configuración del flujo de una campaña.

    Event (API Gateway GET /campaigns/{campaign_id}/flow):
        pathParameters: { "campaign_id": "..." }
    O query: ?campaign_id=xxx
    O body: { "campaign_id": "..." }

    Returns:
        {
            "statusCode": 200,
            "body": {
                "campaign_id": "...",
                "id_campaign": "...",
                "steps": [...],
                "created_at": "...",
                "updated_at": "..."
            }
        }
    """
    try:
        logger.info("🚀 Lambda get-campaign-flow iniciada")
        logger.info(f"📥 Event: {json.dumps(event, default=str)[:500]}")

        campaign_id = _extract_campaign_id(event)

        if not campaign_id:
            return {
                'statusCode': 400,
                'headers': {'Content-Type': 'application/json'},
                'body': json.dumps({
                    'error': 'Bad request',
                    'message': 'campaign_id is required (path, query, or body)'
                })
            }

        load_messages = True
        qs = event.get('queryStringParameters') or {}
        if qs.get('load_messages') == 'false':
            load_messages = False

        flow = get_campaign_flow(campaign_id, load_messages=load_messages)

        if not flow:
            return {
                'statusCode': 404,
                'headers': {'Content-Type': 'application/json'},
                'body': json.dumps({
                    'error': 'Not found',
                    'message': f'Campaign flow not found for campaign_id: {campaign_id}'
                })
            }

        return {
            'statusCode': 200,
            'headers': {'Content-Type': 'application/json'},
            'body': json.dumps(flow, default=str)
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
