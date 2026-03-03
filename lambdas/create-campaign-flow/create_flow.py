import json
import os
import boto3
import logging
from botocore.exceptions import ClientError
from datetime import datetime

# Configurar logging para CloudWatch
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Cliente de DynamoDB
dynamodb = boto3.resource(
    'dynamodb',
    region_name=os.environ.get('AWS_REGION', 'us-east-1')
)

# Cliente de S3
s3_client = boto3.client(
    's3',
    region_name=os.environ.get('AWS_REGION', 'us-east-1')
)

TABLE_NAME = os.environ.get('CAMPAIGN_FLOW_TABLE_NAME', 'uppy_campaign_flow')
S3_BUCKET = os.environ.get('CAMPAIGN_MESSAGES_BUCKET', 'uppy-campaign-messages')


def lambda_handler(event, context):
    """
    Lambda que crea o actualiza un flujo de campaña simplificado
    
    Event structure (desde API Gateway o invocación directa):
    {
        "httpMethod": "POST",  # Solo si viene de API Gateway
        "body": "{...}"  # Solo si viene de API Gateway
        # O directamente:
        {
            "campaign_id": "huggies-co-2025-01",
            "steps": [
                {
                    "step_id": "ACCEPT_CAMPAIGN",
                    "name": "Aceptación de Campaña",
                    "order": 1,
                    "text": "¿Deseas participar en esta campaña?",
                    "accept_button_label": "Aceptar",
                    "reject_button_label": "Rechazar",
                    "transitions": {
                        "accept": "NEXT_STEP_ID",
                        "reject": "REJECTED"  # o "COMPLETED" para completar campaña
                    }
                },
                ...
            ]
        }
    }
    
    Returns:
    {
        "statusCode": 200,
        "body": {
            "campaign_id": "...",
            "steps": [...],
            "created_at": "...",
            "updated_at": "..."
        }
    }
    """
    try:
        logger.info("🚀 Lambda iniciada")
        logger.info(f"📥 Event recibido: {json.dumps(event)}")
        
        # Determinar si viene de API Gateway o invocación directa
        # API Gateway v1 (REST API) tiene 'httpMethod'
        # API Gateway v2 (HTTP API) tiene 'version' y 'requestContext'
        # Invocación directa no tiene ninguno de estos
        
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
            logger.info(f"📦 Body recibido (tipo: {type(body_str)}): {body_str[:200] if isinstance(body_str, str) else body_str}")
            
            if isinstance(body_str, str):
                try:
                    body = json.loads(body_str)
                    logger.info(f"✅ Body parseado correctamente: {json.dumps(body)[:200]}")
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
                    'headers': {
                        'Content-Type': 'application/json'
                    },
                    'body': json.dumps({
                        'error': 'Method not allowed',
                        'message': f'Only POST method is supported, received: {http_method}'
                    })
                }
        else:
            # Invocación directa
            body = event
        
        # Extraer datos
        logger.info(f"🔍 Body después de procesar: {json.dumps(body)[:500]}")
        campaign_id = body.get('campaign_id')
        steps = body.get('steps', [])
        
        logger.info(f"🔍 campaign_id extraído: {campaign_id}")
        logger.info(f"🔍 steps extraído (tipo: {type(steps)}, longitud: {len(steps) if isinstance(steps, list) else 'N/A'})")
        
        # Validaciones
        if not campaign_id:
            logger.error("❌ campaign_id es requerido")
            return {
                'statusCode': 400,
                'body': json.dumps({
                    'error': 'campaign_id is required'
                })
            }
        
        if not steps or not isinstance(steps, list):
            logger.error("❌ steps debe ser un array no vacío")
            return {
                'statusCode': 400,
                'body': json.dumps({
                    'error': 'steps must be a non-empty array'
                })
            }
        
        # Validar estructura de pasos
        validation_error = validate_steps(steps)
        if validation_error:
            logger.error(f"❌ Error de validación: {validation_error}")
            return {
                'statusCode': 400,
                'body': json.dumps({
                    'error': 'Invalid steps structure',
                    'message': validation_error
                })
            }
        
        logger.info(f"✅ Validación exitosa para campaña: {campaign_id}")
        logger.info(f"📊 Número de pasos: {len(steps)}")
        
        # Crear o actualizar el flujo
        flow = create_or_update_flow(campaign_id, steps)
        
        logger.info("✅ Flujo creado/actualizado exitosamente")
        
        # Retornar respuesta
        if 'httpMethod' in event or ('version' in event and 'requestContext' in event):
            # API Gateway format (v1 o v2)
            return {
                'statusCode': 200,
                'headers': {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                },
                'body': json.dumps(flow)
            }
        else:
            # Invocación directa format
            return flow
        
    except ClientError as e:
        error_code = e.response.get('Error', {}).get('Code', 'Unknown')
        error_message = e.response.get('Error', {}).get('Message', str(e))
        
        logger.error(f"❌ Error de AWS DynamoDB: {error_code} - {error_message}")
        import traceback
        logger.error(f"Stack trace: {traceback.format_exc()}")
        
        error_response = {
            'statusCode': 500,
            'error': f'AWS DynamoDB error: {error_code}',
            'message': error_message
        }
        
        if 'httpMethod' in event or ('version' in event and 'requestContext' in event):
            return {
                'statusCode': 500,
                'headers': {
                    'Content-Type': 'application/json'
                },
                'body': json.dumps(error_response)
            }
        else:
            return error_response
            
    except json.JSONDecodeError as e:
        logger.error(f"❌ Error parseando JSON: {e}")
        error_response = {
            'statusCode': 400,
            'error': 'Error parsing JSON in request body'
        }
        
        if 'httpMethod' in event or ('version' in event and 'requestContext' in event):
            return {
                'statusCode': 400,
                'headers': {
                    'Content-Type': 'application/json'
                },
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
                'headers': {
                    'Content-Type': 'application/json'
                },
                'body': json.dumps(error_response)
            }
        else:
            return error_response


def validate_steps(steps):
    """
    Valida la estructura simplificada de los pasos
    
    Cada paso debe tener:
    - step_id: identificador único
    - name: nombre descriptivo del estado (para mostrar al usuario)
    - order: número de orden único
    - text: texto informativo a mostrar
    - accept_button_label: (opcional) texto del botón aceptar (default: "Aceptar")
    - reject_button_label: (opcional) texto del botón rechazar (default: "Rechazar")
    - transitions: objeto con "accept" y "reject" apuntando a step_ids válidos
    
    Args:
        steps: Lista de pasos a validar
    
    Returns:
        str: Mensaje de error si hay problemas, None si está bien
    """
    if not steps:
        return "steps array cannot be empty"
    
    # Validar que todos tengan step_id y order
    step_ids = []
    orders = []
    
    for i, step in enumerate(steps):
        if not isinstance(step, dict):
            return f"Step at index {i} must be an object"
        
        step_id = step.get('step_id')
        name = step.get('name')
        order = step.get('order')
        text = step.get('text')
        transitions = step.get('transitions')
        
        if not step_id:
            return f"Step at index {i} must have a step_id"
        
        if not name or not isinstance(name, str):
            return f"Step {step_id} must have a name (string) field with a descriptive name for the state"
        
        if order is None:
            return f"Step at index {i} must have an order number"
        
        if not isinstance(order, int) or order < 1:
            return f"Step at index {i} must have a positive integer order"
        
        if not text or not isinstance(text, str):
            return f"Step {step_id} must have a text (string) field with the message to display"
        
        if not transitions or not isinstance(transitions, dict):
            return f"Step {step_id} must have a transitions object"
        
        # Validar que transitions tenga "accept" y "reject"
        if 'accept' not in transitions:
            return f"Step {step_id} must have 'accept' in transitions"
        
        if 'reject' not in transitions:
            return f"Step {step_id} must have 'reject' in transitions"
        
        # Validar que los labels de botones sean strings si están presentes
        if 'accept_button_label' in step and not isinstance(step['accept_button_label'], str):
            return f"Step {step_id} accept_button_label must be a string"
        
        if 'reject_button_label' in step and not isinstance(step['reject_button_label'], str):
            return f"Step {step_id} reject_button_label must be a string"
        
        step_ids.append(step_id)
        orders.append(order)
    
    # Validar unicidad de step_id
    if len(step_ids) != len(set(step_ids)):
        return "All step_id values must be unique"
    
    # Validar unicidad de order
    if len(orders) != len(set(orders)):
        return "All order values must be unique"
    
    # Validar que las transiciones apunten a step_id válidos o valores especiales
    # Valores especiales permitidos: COMPLETED (completa campaña), REJECTED (rechaza campaña)
    special_end_values = ['COMPLETED', 'REJECTED']
    
    for step in steps:
        transitions = step.get('transitions', {})
        step_id = step.get('step_id')
        
        for transition_key in ['accept', 'reject']:
            target_step_id = transitions.get(transition_key)
            if target_step_id:
                # Permitir step_ids válidos o valores especiales de fin
                if target_step_id not in step_ids and target_step_id not in special_end_values:
                    return f"Transition '{transition_key}' in step '{step_id}' points to invalid step_id: {target_step_id}. Must be a valid step_id or one of: {special_end_values}"
    
    return None


def upload_message_to_s3(campaign_id, step_id, step_data):
    """
    Sube el mensaje UI simplificado a S3 y retorna la key
    
    Args:
        campaign_id: ID de la campaña
        step_id: ID del paso
        step_data: Objeto con los datos del paso (text, accept_button_label, reject_button_label)
    
    Returns:
        str: S3 key del mensaje subido
    """
    s3_key = f"campaign-flows/{campaign_id}/steps/{step_id}/message.json"
    
    try:
        # Construir el mensaje UI simplificado
        ui_message = {
            'text': step_data.get('text'),
            'accept_button_label': step_data.get('accept_button_label', 'Aceptar'),
            'reject_button_label': step_data.get('reject_button_label', 'Rechazar')
        }
        
        # Convertir a JSON
        message_json = json.dumps(ui_message, ensure_ascii=False)
        
        # Subir a S3
        s3_client.put_object(
            Bucket=S3_BUCKET,
            Key=s3_key,
            Body=message_json.encode('utf-8'),
            ContentType='application/json; charset=utf-8'
        )
        
        logger.info(f"✅ Mensaje subido a S3: {s3_key}")
        return s3_key
    except Exception as e:
        logger.error(f"❌ Error subiendo mensaje a S3: {e}")
        raise


def process_steps_with_s3(campaign_id, steps):
    """
    Procesa los pasos, subiendo mensajes a S3 y creando ui_message_s3_key
    
    Args:
        campaign_id: ID de la campaña
        steps: Lista de pasos con text, accept_button_label, reject_button_label
    
    Returns:
        list: Lista de pasos con ui_message_s3_key y sin text/button labels
    """
    processed_steps = []
    
    for step in steps:
        processed_step = step.copy()
        
        # Extraer datos del mensaje
        text = processed_step.get('text')
        accept_label = processed_step.get('accept_button_label', 'Aceptar')
        reject_label = processed_step.get('reject_button_label', 'Rechazar')
        
        # Si tiene text, subirlo a S3
        if text:
            step_data = {
                'text': text,
                'accept_button_label': accept_label,
                'reject_button_label': reject_label
            }
            s3_key = upload_message_to_s3(campaign_id, step['step_id'], step_data)
            processed_step['ui_message_s3_key'] = s3_key
            
            # Remover campos del mensaje del paso (ya están en S3)
            processed_step.pop('text', None)
            processed_step.pop('accept_button_label', None)
            processed_step.pop('reject_button_label', None)
            
            logger.info(f"📤 Mensaje de paso {step['step_id']} subido a S3: {s3_key}")
        elif 'ui_message_s3_key' in processed_step:
            # Si ya tiene s3_key, mantenerlo (para actualizaciones)
            logger.info(f"ℹ️  Paso {step['step_id']} ya tiene ui_message_s3_key, manteniendo")
        
        processed_steps.append(processed_step)
    
    return processed_steps


def create_or_update_flow(campaign_id, steps):
    """
    Crea o actualiza un flujo de campaña en DynamoDB
    
    Args:
        campaign_id: ID de la campaña
        steps: Lista de pasos del flujo (con text, accept_button_label, reject_button_label)
    
    Returns:
        dict: Flujo creado/actualizado
    """
    table = dynamodb.Table(TABLE_NAME)
    
    now = datetime.utcnow().isoformat()
    
    # Verificar si existe
    try:
        existing = table.get_item(Key={'id_campaign': campaign_id})
        existing_item = existing.get('Item', {})
        created_at = existing_item.get('created_at', now)
        
        # Si existe, verificar si los pasos ya tienen mensajes en S3
        # Si un paso tiene ui_message_s3_key pero no text nuevo, mantener el s3_key
        existing_steps = existing_item.get('steps', [])
        existing_s3_keys = {
            step.get('step_id'): step.get('ui_message_s3_key')
            for step in existing_steps
            if step.get('ui_message_s3_key')
        }
        
        # Para pasos existentes que no tienen text nuevo, mantener el s3_key
        for step in steps:
            if 'text' not in step and step.get('step_id') in existing_s3_keys:
                step['ui_message_s3_key'] = existing_s3_keys[step['step_id']]
    except Exception:
        created_at = now
        existing_s3_keys = {}
    
    # Procesar pasos: subir mensajes a S3
    processed_steps = process_steps_with_s3(campaign_id, steps)
    
    # Preparar item
    # Nota: La tabla DynamoDB usa 'id_campaign' como partition key
    flow_item = {
        'id_campaign': campaign_id,
        'steps': processed_steps,
        'updated_at': now
    }
    
    # Solo agregar created_at si es nuevo
    if created_at == now:
        flow_item['created_at'] = now
    
    # Guardar en DynamoDB
    table.put_item(Item=flow_item)
    
    logger.info(f"✅ Flujo guardado en DynamoDB: {campaign_id}")
    
    # Para la respuesta, también incluir campaign_id para mantener consistencia en la API
    response_item = flow_item.copy()
    response_item['campaign_id'] = campaign_id
    
    return response_item

