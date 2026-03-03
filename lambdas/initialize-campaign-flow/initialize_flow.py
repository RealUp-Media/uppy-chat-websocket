import json
import os
import boto3
import logging
import uuid
from botocore.exceptions import ClientError
from datetime import datetime
from boto3.dynamodb.types import TypeSerializer

# Configurar logging para CloudWatch
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Cliente de DynamoDB
dynamodb = boto3.resource(
    'dynamodb',
    region_name=os.environ.get('AWS_REGION', 'us-east-1')
)

# Cliente de DynamoDB para queries (boto3.client)
dynamodb_client = boto3.client(
    'dynamodb',
    region_name=os.environ.get('AWS_REGION', 'us-east-1')
)

# Cliente de S3
s3_client = boto3.client(
    's3',
    region_name=os.environ.get('AWS_REGION', 'us-east-1')
)

ENROLLMENT_TABLE = os.environ.get('ENROLLMENT_TABLE_NAME', 'uppy_enrollment')
FLOW_TABLE = os.environ.get('CAMPAIGN_FLOW_TABLE_NAME', 'uppy_campaign_flow')
MESSAGES_TABLE = os.environ.get('MESSAGES_TABLE_NAME', 'uppy_chat_messages')
S3_BUCKET = os.environ.get('CAMPAIGN_MESSAGES_BUCKET', 'uppy-campaign-messages')

# Serializador para convertir valores Python a formato DynamoDB
_serializer = TypeSerializer()


def lambda_handler(event, context):
    """
    Lambda que inicializa el flujo de campaña guardando el mensaje inicial
    
    Event structure (desde API Gateway o invocación directa):
    {
        "httpMethod": "POST",  # Solo si viene de API Gateway
        "body": "{...}"  # Solo si viene de API Gateway
        # O directamente:
        {
            "enrollment_id": "uuid-del-enrollment",
            "campaign_id": "maxlit-2024-diciembre"  # Opcional
        }
    }
    
    Returns:
    {
        "statusCode": 200,
        "body": {
            "message": "Flow initialized successfully",
            "enrollment_id": "...",
            "step_id": "...",
            "message_id": "..."
        }
    }
    """
    try:
        logger.info("🚀 Lambda iniciada: initialize-campaign-flow")
        logger.info(f"📥 Event recibido: {json.dumps(event)}")
        
        # Determinar si viene de API Gateway o invocación directa
        if 'httpMethod' in event:
            # API Gateway v1 (REST API)
            body = json.loads(event.get('body', '{}'))
            http_method = event.get('httpMethod', 'POST')
            
            if http_method != 'POST':
                return {
                    'statusCode': 405,
                    'body': json.dumps({
                        'error': 'Method not allowed',
                        'message': f'Only POST method is supported, received: {http_method}'
                    })
                }
        elif 'version' in event and 'requestContext' in event:
            # API Gateway v2 (HTTP API)
            body_str = event.get('body', '{}')
            
            if isinstance(body_str, str):
                try:
                    body = json.loads(body_str)
                except json.JSONDecodeError as e:
                    logger.error(f"❌ Error parseando JSON del body: {e}")
                    return {
                        'statusCode': 400,
                        'headers': {'Content-Type': 'application/json'},
                        'body': json.dumps({
                            'error': 'Invalid JSON in request body',
                            'message': str(e)
                        })
                    }
            else:
                body = body_str
            
            http_method = event.get('requestContext', {}).get('http', {}).get('method', 'POST')
            
            if http_method != 'POST':
                return {
                    'statusCode': 405,
                    'headers': {'Content-Type': 'application/json'},
                    'body': json.dumps({
                        'error': 'Method not allowed',
                        'message': f'Only POST method is supported, received: {http_method}'
                    })
                }
        else:
            # Invocación directa
            body = event
        
        # Extraer datos
        enrollment_id = body.get('enrollment_id')
        campaign_id = body.get('campaign_id')
        
        logger.info(f"🔍 enrollment_id: {enrollment_id}")
        logger.info(f"🔍 campaign_id: {campaign_id}")
        
        # Validaciones
        if not enrollment_id:
            logger.error("❌ enrollment_id es requerido")
            return {
                'statusCode': 400,
                'body': json.dumps({
                    'error': 'enrollment_id is required'
                })
            }
        
        # 1. Obtener enrollment
        logger.info(f"📋 Obteniendo enrollment: {enrollment_id}")
        enrollment = get_enrollment(enrollment_id)
        
        if not enrollment:
            logger.error(f"❌ Enrollment no encontrado: {enrollment_id}")
            return {
                'statusCode': 404,
                'body': json.dumps({
                    'error': 'Enrollment not found'
                })
            }
        
        # Usar campaign_id del enrollment si no se pasó
        if not campaign_id:
            campaign_id = enrollment.get('id_campaign')
            logger.info(f"📋 campaign_id obtenido del enrollment: {campaign_id}")
        
        if not campaign_id:
            logger.error("❌ campaign_id es requerido")
            return {
                'statusCode': 400,
                'body': json.dumps({
                    'error': 'campaign_id is required (not found in enrollment)'
                })
            }
        
        # 2. Obtener flujo y paso inicial
        logger.info(f"📋 Obteniendo flujo de campaña: {campaign_id}")
        flow = get_campaign_flow(campaign_id)
        
        if not flow:
            logger.error(f"❌ Flujo de campaña no encontrado: {campaign_id}")
            return {
                'statusCode': 404,
                'body': json.dumps({
                    'error': 'Campaign flow not found'
                })
            }
        
        logger.info(f"📋 Obteniendo paso inicial del flujo")
        initial_step = get_initial_step(flow)
        
        if not initial_step:
            logger.error(f"❌ Paso inicial no encontrado en flujo: {campaign_id}")
            return {
                'statusCode': 404,
                'body': json.dumps({
                    'error': 'Initial step not found in campaign flow'
                })
            }
        
        step_id = initial_step.get('step_id')
        logger.info(f"✅ Paso inicial encontrado: {step_id}")
        
        # 3. Cargar mensaje desde S3
        s3_key = initial_step.get('ui_message_s3_key')
        if not s3_key:
            logger.error(f"❌ ui_message_s3_key no encontrado en paso: {step_id}")
            return {
                'statusCode': 404,
                'body': json.dumps({
                    'error': 'Message S3 key not found in initial step'
                })
            }
        
        logger.info(f"📥 Cargando mensaje desde S3: {s3_key}")
        message_data = load_message_from_s3(s3_key)
        
        if not message_data:
            logger.error(f"❌ Mensaje no encontrado en S3: {s3_key}")
            return {
                'statusCode': 404,
                'body': json.dumps({
                    'error': 'Message not found in S3'
                })
            }
        
        # 4. Personalizar mensaje (reemplazar [Nombre] si existe)
        message_text = message_data.get('text', '')
        # TODO: Si necesitas personalizar con nombre del influencer, obtenerlo aquí
        # influencer_data = get_influencer_data(enrollment.get('id_influencer'))
        # message_text = message_text.replace('[Nombre]', influencer_data.get('name', 'Influencer'))
        
        # 5. Actualizar enrollment con current_step_id
        logger.info(f"📝 Actualizando enrollment con current_step_id: {step_id}")
        update_enrollment_step(enrollment_id, step_id, enrollment)
        
        # 6. Guardar mensaje en DynamoDB
        logger.info(f"💾 Guardando mensaje inicial en DynamoDB")
        message = save_initial_message(
            enrollment_id=enrollment_id,
            campaign_id=campaign_id,
            step_id=step_id,
            message_text=message_text,
            accept_label=message_data.get('accept_button_label', 'Aceptar'),
            reject_label=message_data.get('reject_button_label', 'Rechazar'),
            transitions=initial_step.get('transitions', {})
        )
        
        logger.info(f"✅ Flujo inicializado exitosamente para enrollment: {enrollment_id}")
        
        # Retornar respuesta
        response_body = {
            'message': 'Flow initialized successfully',
            'enrollment_id': enrollment_id,
            'step_id': step_id,
            'message_id': message['message_id']
        }
        
        if 'httpMethod' in event or ('version' in event and 'requestContext' in event):
            # API Gateway format
            return {
                'statusCode': 200,
                'headers': {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                },
                'body': json.dumps(response_body)
            }
        else:
            # Invocación directa format
            return response_body
        
    except ClientError as e:
        error_code = e.response.get('Error', {}).get('Code', 'Unknown')
        error_message = e.response.get('Error', {}).get('Message', str(e))
        
        logger.error(f"❌ Error de AWS: {error_code} - {error_message}")
        import traceback
        logger.error(f"Stack trace: {traceback.format_exc()}")
        
        error_response = {
            'statusCode': 500,
            'error': f'AWS error: {error_code}',
            'message': error_message
        }
        
        if 'httpMethod' in event or ('version' in event and 'requestContext' in event):
            return {
                'statusCode': 500,
                'headers': {'Content-Type': 'application/json'},
                'body': json.dumps(error_response)
            }
        else:
            return error_response
            
    except Exception as e:
        logger.error(f"❌ Error inesperado: {type(e).__name__}: {e}")
        import traceback
        error_trace = traceback.format_exc()
        logger.error(f"Stack trace: {error_trace}")
        
        error_response = {
            'statusCode': 500,
            'error': 'Unexpected error processing request',
            'message': str(e),
            'trace': error_trace
        }
        
        if 'httpMethod' in event or ('version' in event and 'requestContext' in event):
            return {
                'statusCode': 500,
                'headers': {'Content-Type': 'application/json'},
                'body': json.dumps(error_response)
            }
        else:
            return error_response


def serialize_value(value):
    """
    Convierte un valor Python a formato DynamoDB usando TypeSerializer
    
    Args:
        value: Valor Python (str, int, float, bool, etc.)
    
    Returns:
        dict: Valor en formato DynamoDB
    """
    return _serializer.serialize(value)


def get_enrollment(enrollment_id):
    """
    Obtiene un enrollment de DynamoDB usando el GSI enrollment-id-index
    
    Args:
        enrollment_id: ID del enrollment
    
    Returns:
        dict: Enrollment o None si no existe
    """
    try:
        # Usar boto3.client para queries con GSI
        # Necesitamos convertir el valor a formato DynamoDB
        response = dynamodb_client.query(
            TableName=ENROLLMENT_TABLE,
            IndexName='enrollment-id-index',
            KeyConditionExpression='enrollment_id = :enrollmentId',
            ExpressionAttributeValues={
                ':enrollmentId': serialize_value(enrollment_id)
            },
            Limit=1
        )
        
        items = response.get('Items', [])
        if items:
            # Convertir formato DynamoDB a dict normal
            enrollment = convert_dynamodb_item(items[0])
            logger.info(f"✅ Enrollment encontrado: {enrollment_id}")
            return enrollment
        
        logger.warn(f"⚠️  Enrollment no encontrado: {enrollment_id}")
        return None
        
    except ClientError as e:
        error_code = e.response.get('Error', {}).get('Code', '')
        if error_code == 'ResourceNotFoundException':
            logger.warn(f"⚠️  GSI enrollment-id-index no encontrado, intentando Scan")
            # Fallback: usar Scan (menos eficiente)
            return get_enrollment_scan(enrollment_id)
        raise
    except Exception as e:
        logger.error(f"❌ Error obteniendo enrollment: {e}")
        raise


def get_enrollment_scan(enrollment_id):
    """
    Fallback: Obtiene enrollment usando Scan (menos eficiente)
    """
    try:
        table = dynamodb.Table(ENROLLMENT_TABLE)
        response = table.scan(
            FilterExpression='enrollment_id = :enrollmentId',
            ExpressionAttributeValues={
                ':enrollmentId': enrollment_id
            },
            Limit=1
        )
        
        items = response.get('Items', [])
        if items:
            logger.info(f"✅ Enrollment encontrado (Scan): {enrollment_id}")
            return items[0]
        
        return None
    except Exception as e:
        logger.error(f"❌ Error en Scan de enrollment: {e}")
        return None


def convert_dynamodb_item(item):
    """
    Convierte un item DynamoDB (formato boto3.client) a dict normal
    
    Args:
        item: Item en formato DynamoDB
    
    Returns:
        dict: Item convertido
    """
    result = {}
    for key, value in item.items():
        if 'S' in value:
            result[key] = value['S']
        elif 'N' in value:
            # Intentar int primero, luego float
            num_str = value['N']
            try:
                if '.' in num_str:
                    result[key] = float(num_str)
                else:
                    result[key] = int(num_str)
            except ValueError:
                result[key] = num_str
        elif 'BOOL' in value:
            result[key] = value['BOOL']
        elif 'L' in value:
            result[key] = [convert_dynamodb_value(v) for v in value['L']]
        elif 'M' in value:
            result[key] = {k: convert_dynamodb_value(v) for k, v in value['M'].items()}
        elif 'SS' in value:
            result[key] = set(value['SS'])
        elif 'NS' in value:
            result[key] = set([int(n) if '.' not in n else float(n) for n in value['NS']])
        elif 'BS' in value:
            result[key] = set(value['BS'])
        elif 'NULL' in value:
            result[key] = None
    return result


def convert_dynamodb_value(value):
    """Convierte un valor DynamoDB a Python nativo"""
    if isinstance(value, dict):
        if 'S' in value:
            return value['S']
        elif 'N' in value:
            num_str = value['N']
            try:
                return int(num_str) if '.' not in num_str else float(num_str)
            except ValueError:
                return num_str
        elif 'BOOL' in value:
            return value['BOOL']
        elif 'L' in value:
            return [convert_dynamodb_value(v) for v in value['L']]
        elif 'M' in value:
            return {k: convert_dynamodb_value(v) for k, v in value['M'].items()}
    return value


def get_campaign_flow(campaign_id):
    """
    Obtiene el flujo de campaña de DynamoDB
    
    Args:
        campaign_id: ID de la campaña
    
    Returns:
        dict: Flujo de campaña o None si no existe
    """
    try:
        table = dynamodb.Table(FLOW_TABLE)
        response = table.get_item(Key={'id_campaign': campaign_id})
        
        if 'Item' in response:
            logger.info(f"✅ Flujo encontrado: {campaign_id}")
            return response['Item']
        
        logger.warn(f"⚠️  Flujo no encontrado: {campaign_id}")
        return None
    except Exception as e:
        logger.error(f"❌ Error obteniendo flujo: {e}")
        raise


def get_initial_step(flow):
    """
    Obtiene el paso inicial del flujo (order: 1)
    
    Args:
        flow: Flujo de campaña
    
    Returns:
        dict: Paso inicial o None si no existe
    """
    steps = flow.get('steps', [])
    if not steps:
        return None
    
    # Ordenar por order y obtener el primero
    sorted_steps = sorted(steps, key=lambda x: x.get('order', 0))
    initial_step = sorted_steps[0] if sorted_steps else None
    
    if initial_step:
        logger.info(f"✅ Paso inicial encontrado: {initial_step.get('step_id')} (order: {initial_step.get('order')})")
    
    return initial_step


def load_message_from_s3(s3_key):
    """
    Carga el mensaje desde S3
    
    Args:
        s3_key: Key del objeto en S3
    
    Returns:
        dict: Mensaje o None si no existe
    """
    try:
        response = s3_client.get_object(Bucket=S3_BUCKET, Key=s3_key)
        body = response['Body'].read().decode('utf-8')
        message = json.loads(body)
        
        logger.info(f"✅ Mensaje cargado desde S3: {s3_key}")
        return message
    except ClientError as e:
        if e.response['Error']['Code'] == 'NoSuchKey':
            logger.error(f"❌ Mensaje no encontrado en S3: {s3_key}")
        else:
            logger.error(f"❌ Error cargando mensaje de S3: {e}")
        return None
    except Exception as e:
        logger.error(f"❌ Error procesando mensaje de S3: {e}")
        return None


def update_enrollment_step(enrollment_id, step_id, enrollment):
    """
    Actualiza el current_step_id del enrollment
    
    Args:
        enrollment_id: ID del enrollment
        step_id: Nuevo step_id
        enrollment: Objeto enrollment completo (para tener las keys)
    """
    try:
        table = dynamodb.Table(ENROLLMENT_TABLE)
        now = datetime.utcnow().isoformat()
        
        # Actualizar usando PutItem con el enrollment completo
        updated_enrollment = enrollment.copy()
        updated_enrollment['current_step_id'] = step_id
        updated_enrollment['updated_at'] = now
        
        table.put_item(Item=updated_enrollment)
        
        logger.info(f"✅ Enrollment actualizado: {enrollment_id} -> current_step_id: {step_id}")
    except Exception as e:
        logger.error(f"❌ Error actualizando enrollment: {e}")
        raise


def save_initial_message(enrollment_id, campaign_id, step_id, message_text, 
                        accept_label, reject_label, transitions):
    """
    Guarda el mensaje inicial en uppy_chat_messages
    
    Args:
        enrollment_id: ID del enrollment
        campaign_id: ID de la campaña
        step_id: ID del paso
        message_text: Texto del mensaje
        accept_label: Label del botón aceptar
        reject_label: Label del botón rechazar
        transitions: Transiciones del paso
    
    Returns:
        dict: Mensaje guardado
    """
    try:
        table = dynamodb.Table(MESSAGES_TABLE)
        
        message_id = str(uuid.uuid4())
        now = datetime.utcnow().isoformat()
        
        # Construir botones basados en transitions
        buttons = []
        if 'accept' in transitions:
            buttons.append({
                'id': 'accept',
                'label': accept_label,
                'action': 'accept'
            })
        if 'reject' in transitions:
            buttons.append({
                'id': 'reject',
                'label': reject_label,
                'action': 'reject'
            })
        
        message = {
            'message_id': message_id,
            'conversation_id': enrollment_id,
            'sender_id': 'system',
            'sender_type': 'system',
            'sender_username': 'Sistema',
            'message_text': message_text,
            'message_type': 'campaign_flow_step',
            'step_id': step_id,
            'campaign_id': campaign_id,
            'buttons': buttons,
            'created_at': now
        }
        
        table.put_item(Item=message)
        
        logger.info(f"✅ Mensaje inicial guardado: {message_id}")
        return message
    except Exception as e:
        logger.error(f"❌ Error guardando mensaje inicial: {e}")
        raise
