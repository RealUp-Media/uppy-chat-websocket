import json
import os
import boto3
import logging
from botocore.exceptions import ClientError

# Configurar logging para CloudWatch
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Cliente de Bedrock Runtime
bedrock_runtime = boto3.client(
    'bedrock-runtime',
    region_name=os.environ.get('AWS_REGION', 'us-east-1')
)


# Modelo de Bedrock a usar (configurable por variable de entorno)
MODEL_ID = os.environ.get(
    'BEDROCK_MODEL_ID', 
    'us.anthropic.claude-sonnet-4-6'
)

def lambda_handler(event, context):
    """
    Lambda que genera respuestas con IA usando Bedrock para influencers
    
    Event structure (invocación directa):
    {
        "conversation_id": "enrollment-123",
        "message_text": "Mensaje del influencer",
        "conversation_history": [...],  # Opcional: historial de mensajes
        "influencer_context": {...}      # Opcional: contexto adicional
    }
    
    Returns:
    {
        "conversation_id": "...",
        "ai_response": "Respuesta generada por IA",
        "model_used": "..."
    }
    """
    try:
        logger.info("🚀 Lambda iniciada")
        logger.info(f"📥 Event recibido: {json.dumps(event)}")
        
        # El evento viene directamente del SDK (no API Gateway)
        body = event
        
        # Extraer datos del evento
        conversation_id = body.get('conversation_id')
        message_text = body.get('message_text')
        conversation_history = body.get('conversation_history', [])
        influencer_context = body.get('influencer_context', {})
        flow_context = body.get('flow_context')
        
        logger.info(f"💬 Conversation ID: {conversation_id}")
        logger.info(f"📝 Message text: {message_text[:100] if message_text else 'N/A'}...")
        logger.info(f"📚 History length: {len(conversation_history)}")
        logger.info(f"🔄 Flow context: {'Sí' if flow_context else 'No'}")
        
        # Validación
        if not message_text:
            logger.error("❌ message_text es requerido")
            return {
                'statusCode': 400,
                'error': 'message_text es requerido'
            }
        
        logger.info("🔨 Construyendo prompt...")
        # Construir el prompt para Claude
        prompt = build_prompt(message_text, conversation_history, influencer_context, flow_context)
        logger.info(f"✅ Prompt construido, mensajes: {len(prompt.get('messages', []))}")
        
        logger.info(f"🤖 Invocando Bedrock con modelo: {MODEL_ID}")
        # Invocar Bedrock
        response = invoke_bedrock(prompt)
        logger.info("✅ Respuesta de Bedrock recibida")
        
        # Extraer la respuesta del modelo
        ai_response = extract_response(response)
        logger.info(f"📤 Respuesta extraída: {ai_response[:100]}...")
        
        result = {
            'conversation_id': conversation_id,
            'ai_response': ai_response,
            'model_used': MODEL_ID
        }
        
        logger.info("✅ Lambda completada exitosamente")
        logger.info(f"📤 Retornando: {json.dumps(result)[:200]}...")
        
        # Retornar directamente el objeto (sin formato API Gateway)
        return result
        
    except ClientError as e:
        error_code = e.response.get('Error', {}).get('Code', 'Unknown')
        error_message = e.response.get('Error', {}).get('Message', str(e))
        
        logger.error(f"❌ Error de AWS Bedrock: {error_code} - {error_message}")
        import traceback
        logger.error(f"Stack trace: {traceback.format_exc()}")
        
        return {
            'statusCode': 500,
            'error': f'Error de AWS Bedrock: {error_code}',
            'message': error_message
        }
    except json.JSONDecodeError as e:
        logger.error(f"❌ Error parseando JSON: {e}")
        return {
            'statusCode': 400,
            'error': 'Error parseando JSON del request'
        }
    except Exception as e:
        logger.error(f"❌ Error inesperado: {type(e).__name__}: {e}")
        import traceback
        error_trace = traceback.format_exc()
        logger.error(f"Stack trace: {error_trace}")
        
        return {
            'statusCode': 500,
            'error': 'Error inesperado al procesar la solicitud',
            'message': str(e),
            'trace': error_trace
        }


def load_system_prompt():
    """
    Carga el system prompt desde el archivo system_prompt.txt
    
    Returns:
        str: System prompt cargado
    """
    current_dir = os.path.dirname(os.path.abspath(__file__))
    prompt_path = os.path.join(current_dir, 'system_prompt.txt')
    
    with open(prompt_path, 'r', encoding='utf-8') as f:
        return f.read().strip()


def build_prompt(message_text, conversation_history, influencer_context, flow_context=None):
    """
    Construye el prompt para Claude con el contexto necesario
    
    Args:
        message_text: Texto del mensaje del influencer (mensaje ACTUAL al que debe responder)
        conversation_history: Lista de mensajes anteriores (sin incluir el mensaje actual)
        influencer_context: Contexto adicional del influencer
        flow_context: Contexto del flujo de campaña con pasos y mensajes
    
    Returns:
        dict: Prompt formateado para Claude
    """
    # Cargar el system prompt desde el archivo system_prompt.txt
    system_prompt = load_system_prompt()
    
    # Agregar contexto del flujo al system prompt si existe
    if flow_context:
        flow_info = []
        flow_info.append(f"\n\n## Contexto de la Campaña")
        flow_info.append(f"Campaign ID: {flow_context.get('campaign_id', 'N/A')}")
        flow_info.append(f"Paso actual: {flow_context.get('current_step_id', 'N/A')}")
        
        current_step = flow_context.get('current_step', {})
        if current_step.get('message'):
            flow_info.append(f"\n### Mensaje del paso actual:")
            flow_info.append(f"{current_step['message'].get('text', '')}")
        
        # Agregar información de todos los pasos del flujo
        flow_steps = flow_context.get('flow_steps', [])
        if flow_steps:
            flow_info.append(f"\n### Pasos de la campaña ({len(flow_steps)} pasos):")
            for step in flow_steps:
                step_info = f"\n- Paso {step.get('order', '?')}: {step.get('step_id', 'N/A')}"
                if step.get('message'):
                    step_info += f"\n  Mensaje: {step.get('message', {}).get('text', '')[:200]}..."
                if step.get('transitions'):
                    step_info += f"\n  Transiciones: {', '.join(step.get('transitions', {}).keys())}"
                flow_info.append(step_info)
        
        system_prompt += "\n".join(flow_info)
        logger.info(f"✅ Contexto de flujo agregado al system prompt ({len(flow_steps)} pasos)")

    # Construir el array de mensajes en formato Claude
    messages = []
    last_role = None

    # Agregar historial de conversación si existe
    if conversation_history and len(conversation_history) > 0:
        # Filtrar y ordenar mensajes: excluir el mensaje actual si está presente
        # y tomar solo los últimos 10 mensajes para contexto
        filtered_history = []
        for msg in conversation_history:
            # Excluir el mensaje actual si está en el historial (por seguridad)
            msg_text = msg.get('message_text') or ''
            if msg_text != message_text:
                filtered_history.append(msg)
        
        # conversation_history viene ordenado: [más reciente, ..., más antiguo]
        # Tomar los 10 más recientes y revertir a orden cronológico (antiguo → reciente)
        slice_ = filtered_history[:10] if len(filtered_history) > 10 else filtered_history
        recent_messages = list(reversed(slice_))
        
        # Convertir el historial al formato de mensajes de Claude
        # IMPORTANTE: Los roles deben alternar (user -> assistant -> user -> assistant)
        last_role = None
        for msg in recent_messages:
            sender_type = msg.get('sender_type', 'unknown')
            text = msg.get('message_text') or ''
            
            # Determinar el rol según el tipo de remitente
            if sender_type == 'influencer' or sender_type == 'operations':
                # Mensaje del influencer u operations = role 'user'
                new_role = "user"
                content = f"[Operaciones]: {text}" if sender_type == 'operations' else text
            elif sender_type == 'ai':
                # Respuesta anterior de IA = role 'assistant'
                new_role = "assistant"
                content = text
            else:
                # Saltar mensajes desconocidos
                continue
            
            # Solo agregar si el rol es diferente al anterior (alternar roles)
            if new_role != last_role:
                messages.append({
                    "role": new_role,
                    "content": content if content is not None else ""
                })
                last_role = new_role
            else:
                # Si el rol es el mismo, combinar con el mensaje anterior
                if len(messages) > 0:
                    prev = messages[-1]["content"]
                    messages[-1]["content"] = (prev if prev is not None else "") + f"\n\n{content or ''}"
                else:
                    # Si no hay mensajes previos y es "user", agregarlo
                    if new_role == "user":
                        messages.append({
                            "role": new_role,
                            "content": content if content is not None else ""
                        })
                        last_role = new_role
    
    # IMPORTANTE: El mensaje actual del influencer es el ÚLTIMO mensaje
    # Usa el historial anterior como contexto, pero responde SOLO a este último mensaje
    # Agregar instrucción explícita al final para enfatizar que debe responder solo a la última pregunta
    final_message = f"{message_text}\n\n[Nota: El historial anterior es solo contexto. Responde SOLO a este último mensaje.]"
    
    if last_role != "user":
        messages.append({
            "role": "user",
            "content": final_message
        })
    else:
        # Si el último es "user", reemplazar con el mensaje actual (no combinar)
        # porque este es el mensaje al que debe responder
        if len(messages) > 0:
            messages[-1]["content"] = final_message
        else:
            messages.append({
                "role": "user",
                "content": final_message
            })
    
    # VALIDACIÓN FINAL: El primer mensaje DEBE ser "user" según la API de Claude
    # Si el historial empieza con "assistant", remover mensajes "assistant" del inicio
    while len(messages) > 0 and messages[0].get("role") == "assistant":
        messages.pop(0)
    
    # Si después de filtrar no quedan mensajes, agregar el mensaje actual
    if len(messages) == 0:
        messages.append({
            "role": "user",
            "content": message_text
        })
    
    # Formato para Claude 3 (Message API)
    return {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 500,
        "temperature": 0.3,
        "system": system_prompt,
        "messages": messages
    }


def invoke_bedrock(prompt):
    """
    Invoca el modelo de Bedrock con el prompt proporcionado
    
    Args:
        prompt: Diccionario con el prompt formateado para Claude
    
    Returns:
        dict: Respuesta completa de Bedrock
    """
    body = json.dumps(prompt)
    
    response = bedrock_runtime.invoke_model(
        modelId=MODEL_ID,
        body=body,
        contentType='application/json',
        accept='application/json'
    )
    
    response_body = json.loads(response['body'].read())
    return response_body


def extract_response(bedrock_response):
    """
    Extrae el texto de la respuesta de Bedrock
    
    Args:
        bedrock_response: Respuesta completa de Bedrock
    
    Returns:
        str: Texto de la respuesta generada
    """
    if 'content' in bedrock_response:
        for block in bedrock_response['content']:
            if block['type'] == 'text':
                return block['text'].strip()
    
    # Si no hay contenido de texto, intentar otros formatos
    if 'text' in bedrock_response:
        return bedrock_response['text'].strip()
    
    raise ValueError("No se pudo extraer la respuesta del modelo. Respuesta recibida: " + json.dumps(bedrock_response))