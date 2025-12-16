import { dynamoDB, GetCommand, PutCommand, QueryCommand, ScanCommand } from './dynamodb.js'
import { v4 as uuidv4 } from 'uuid'

const TABLE_NAME = 'uppy_chat_messages'

/**
 * Guarda un mensaje en DynamoDB
 */
export async function saveMessage(messageData) {
  const {
    conversationId, // enrollment_id
    senderId,
    senderType, // 'influencer' | 'operations'
    messageText
  } = messageData

  const messageId = uuidv4()
  const now = new Date().toISOString()

  const message = {
    message_id: messageId,
    conversation_id: conversationId,
    sender_id: senderId,
    sender_type: senderType,
    message_text: messageText,
    created_at: now
  }

  try {
    await dynamoDB.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: message
    }))
  } catch (error) {
    // Si hay error de credenciales, solo loguear pero continuar (para desarrollo)
    if (error.name === 'UnrecognizedClientException' || error.message?.includes('security token')) {
      console.warn('⚠️  Error de credenciales AWS al guardar mensaje. El mensaje no se guardó en DynamoDB.')
      console.warn('⚠️  El mensaje se enviará por WebSocket pero no se persistirá hasta que arregles las credenciales.')
      // Continuar y retornar el mensaje para que se envíe por WebSocket
    } else {
      // Si es otro tipo de error, lanzarlo
      throw error
    }
  }

  return message
}

/**
 * Obtiene el historial de mensajes de una conversación
 */
export async function getConversationHistory(conversationId, limit = 50) {
  try {
    const result = await dynamoDB.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'conversation_id-index', // GSI necesario para queries por conversación
      KeyConditionExpression: 'conversation_id = :conversationId',
      ExpressionAttributeValues: {
        ':conversationId': conversationId
      },
      ScanIndexForward: false, // Orden descendente (más recientes primero)
      Limit: limit
    }))

    return result.Items || []
  } catch (error) {
    // Si el índice no existe, intentar scan (menos eficiente pero funcional)
    if (error.name === 'ResourceNotFoundException' || error.message.includes('index')) {
      console.warn('GSI not found, falling back to scan. Consider creating conversation_id-index')
      
      try {
        const result = await dynamoDB.send(new ScanCommand({
          TableName: TABLE_NAME,
          FilterExpression: 'conversation_id = :conversationId',
          ExpressionAttributeValues: {
            ':conversationId': conversationId
          },
          Limit: limit
        }))

        // Ordenar por fecha descendente
        return (result.Items || []).sort((a, b) => 
          new Date(b.created_at) - new Date(a.created_at)
        )
      } catch (scanError) {
        console.error('Error en scan:', scanError)
        // Si hay error de credenciales, retornar array vacío para desarrollo
        if (scanError.name === 'UnrecognizedClientException' || scanError.message?.includes('security token')) {
          console.warn('⚠️  Error de credenciales AWS. Retornando historial vacío.')
          return []
        }
        throw scanError
      }
    }
    
    // Si hay error de credenciales, retornar array vacío para desarrollo
    if (error.name === 'UnrecognizedClientException' || error.message?.includes('security token')) {
      console.warn('⚠️  Error de credenciales AWS. Retornando historial vacío.')
      return []
    }
    
    throw error
  }
}

/**
 * Verifica si un influencer tiene acceso a un enrollment
 * @param {string} enrollmentId - El enrollment_id de la conversación
 * @param {string} idInfluencerMain - El custom:id_influencer_main del usuario (de Cognito)
 * @returns {Promise<boolean>} true si tiene acceso, false si no, o null si hubo error de credenciales
 */
export async function verifyInfluencerAccess(enrollmentId, idInfluencerMain) {
  try {
    // La tabla uppy_enrollment tiene clave primaria compuesta (id_campaign, id_influencer)
    // Pero buscamos por enrollment_id que es un atributo regular
    // Usamos Scan con FilterExpression para buscar por enrollment_id
    const result = await dynamoDB.send(new ScanCommand({
      TableName: 'uppy_enrollment',
      FilterExpression: 'enrollment_id = :enrollmentId',
      ExpressionAttributeValues: {
        ':enrollmentId': enrollmentId
      },
      Limit: 1 // Solo necesitamos un resultado
    }))

    if (!result.Items || result.Items.length === 0) {
      return false
    }

    const enrollment = result.Items[0]

    // Comparar con id_influencer del enrollment (que corresponde a id_influencer_main)
    return enrollment.id_influencer === idInfluencerMain
  } catch (error) {
    // Si es un error de credenciales de AWS, permitir acceso con warning (solo para desarrollo)
    if (error.name === 'UnrecognizedClientException' || 
        error.message?.includes('security token') ||
        error.message?.includes('invalid')) {
      console.warn('⚠️  Error de credenciales AWS. Permitiendo acceso temporalmente. Arregla las credenciales para producción.')
      // En desarrollo, permitir acceso si hay error de credenciales
      // En producción, deberías rechazar el acceso
      return true // Cambiar a false en producción si quieres bloquear sin credenciales válidas
    }
    
    console.error('Error verifying influencer access:', error)
    return false
  }
}

