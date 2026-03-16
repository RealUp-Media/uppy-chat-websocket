import { dynamoDB, GetCommand, PutCommand, QueryCommand, ScanCommand } from './dynamodb.js'
import { v4 as uuidv4 } from 'uuid'

const TABLE_NAME = 'uppy_chat_messages'

/**
 * Guarda un mensaje en DynamoDB.
 *
 * Campos opcionales de flujo de campaña (flowData):
 *   message_type  — 'campaign_flow_step' para mensajes del sistema de flujo
 *   step_id       — ID del paso actual
 *   campaign_id   — ID de la campaña
 *   step_type     — 'buttons' | 'input' | 'upload'
 *   buttons       — Array de botones (para step_type 'buttons')
 *   input_config  — Configuración del input (para step_type 'input')
 *   upload_config — Configuración del upload (para step_type 'upload')
 */
export async function saveMessage(messageData) {
  const {
    conversationId, // enrollment_id
    senderId,
    senderType, // 'influencer' | 'operations' | 'system'
    senderUsername, // username del remitente
    messageText,
    attachments, // Array de archivos adjuntos: [{s3Key, url, fileName, fileSize, mimeType}]
    // Campos de flujo de campaña (opcionales)
    flowData
  } = messageData

  const messageId = uuidv4()
  const now = new Date().toISOString()

  const message = {
    message_id: messageId,
    conversation_id: conversationId,
    sender_id: senderId,
    sender_type: senderType,
    sender_username: senderUsername || null,
    message_text: messageText || null,
    created_at: now
  }

  // Agregar información de archivos adjuntos si existen
  if (attachments && Array.isArray(attachments) && attachments.length > 0) {
    message.attachments = attachments
  }

  // Persistir campos de flujo de campaña para que el historial los incluya
  if (flowData && typeof flowData === 'object') {
    const {
      message_type, step_id, campaign_id,
      step_type, buttons, input_config, upload_config
    } = flowData

    if (message_type) message.message_type = message_type
    if (step_id)      message.step_id      = step_id
    if (campaign_id)  message.campaign_id  = campaign_id
    if (step_type)    message.step_type    = step_type
    if (buttons && Array.isArray(buttons) && buttons.length > 0) {
      message.buttons = buttons
    }
    if (input_config && typeof input_config === 'object') {
      message.input_config = input_config
    }
    if (upload_config && typeof upload_config === 'object') {
      message.upload_config = upload_config
    }
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
 * Obtiene las entregas (inputs y uploads) de influencers por paso de campaña.
 * Útil para dashboards que muestran qué subió cada influencer en cada paso.
 *
 * @param {string} campaignId - ID de la campaña
 * @param {string} [stepId] - Opcional: filtrar por step_id específico
 * @param {number} [limit=200] - Límite de resultados
 * @returns {Promise<Array>} Lista de entregas con message_text, attachments, step_id, conversation_id (enrollment_id), etc.
 */
export async function getStepSubmissions(campaignId, stepId = null, limit = 200) {
  try {
    const filterParts = ['campaign_id = :cid', 'message_type = :mt']
    const exprValues = { ':cid': campaignId, ':mt': 'user_step_submission' }
    if (stepId) {
      filterParts.push('step_id = :sid')
      exprValues[':sid'] = stepId
    }

    const params = {
      TableName: TABLE_NAME,
      FilterExpression: filterParts.join(' AND '),
      ExpressionAttributeValues: exprValues,
      Limit: limit
    }

    const result = await dynamoDB.send(new ScanCommand(params))
    const items = result.Items || []

    // Ordenar por created_at descendente (más recientes primero)
    items.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))

    return items.map(({ message_id, conversation_id, sender_id, sender_username, message_text, attachments, step_id, campaign_id, created_at }) => ({
      message_id,
      enrollment_id: conversation_id,
      sender_id,
      sender_username,
      message_text: message_text || null,
      attachments: attachments || [],
      step_id,
      campaign_id,
      created_at
    }))
  } catch (error) {
    if (error.name === 'UnrecognizedClientException' || error.message?.includes('security token')) {
      console.warn('⚠️  Error de credenciales AWS. Retornando entregas vacías.')
      return []
    }
    throw error
  }
}

/**
 * Verifica si un influencer tiene acceso a un enrollment
 * @param {string} enrollmentId - El enrollment_id de la conversación
 * @param {string} idInfluencerMain - El custom:id_influencer_main del usuario (de Cognito)
 * @returns {Promise<boolean>} true si tiene acceso, false si no
 */
export async function verifyInfluencerAccess(enrollmentId, idInfluencerMain) {
  try {
    if (!idInfluencerMain) {
      console.warn('⚠️  idInfluencerMain is null or empty')
      return false
    }

    // Obtener el enrollment
    let enrollment = null
    try {
      const result = await dynamoDB.send(new QueryCommand({
        TableName: 'uppy_enrollment',
        IndexName: 'enrollment-id-index',
        KeyConditionExpression: 'enrollment_id = :enrollmentId',
        ExpressionAttributeValues: {
          ':enrollmentId': enrollmentId
        },
        Limit: 1
      }))

      if (result.Items && result.Items.length > 0) {
        enrollment = result.Items[0]
      }
    } catch (error) {
      // Si el índice no existe, intentar Scan como fallback
      if (error.name === 'ResourceNotFoundException' || error.message?.includes('index')) {
        try {
          const scanResult = await dynamoDB.send(new ScanCommand({
            TableName: 'uppy_enrollment',
            FilterExpression: 'enrollment_id = :enrollmentId',
            ExpressionAttributeValues: {
              ':enrollmentId': enrollmentId
            },
            Limit: 1
          }))

          if (scanResult.Items && scanResult.Items.length > 0) {
            enrollment = scanResult.Items[0]
          }
        } catch (scanError) {
          console.error('Error finding enrollment:', scanError)
          return false
        }
      } else {
        throw error
      }
    }

    if (!enrollment) {
      console.warn(`⚠️  Enrollment ${enrollmentId} not found`)
      return false
    }

    // Ahora obtener todos los id_influencer que pertenecen a este usuario
    // Un usuario (id_influencer_main) puede tener múltiples perfiles sociales (id_influencer)
    let userInfluencerIds = []
    let usedScan = false
    try {
      console.log(`🔍 Querying uppy_influencer with influencer-main-index for id_influencer_main: ${idInfluencerMain}`)
      const influencerResult = await dynamoDB.send(new QueryCommand({
        TableName: 'uppy_influencer',
        IndexName: 'influencer-main-index', // GSI con id_influencer_main como partition key
        KeyConditionExpression: 'id_influencer_main = :idInfluencerMain',
        ExpressionAttributeValues: {
          ':idInfluencerMain': idInfluencerMain
        }
      }))

      console.log(`📊 Query result: ${influencerResult.Items?.length || 0} items found`)
      if (influencerResult.Items && influencerResult.Items.length > 0) {
        userInfluencerIds = influencerResult.Items.map(item => item.id_influencer)
        console.log(`✅ User id_influencer_main ${idInfluencerMain} has ${userInfluencerIds.length} social profiles:`, userInfluencerIds)
      } else {
        console.warn(`⚠️  Query returned 0 items for id_influencer_main ${idInfluencerMain}`)
      }
    } catch (error) {
      console.error(`❌ Query error: ${error.name} - ${error.message}`)
      // Si el índice no existe, intentar Scan como fallback
      if (error.name === 'ResourceNotFoundException' || error.message?.includes('index')) {
        console.warn('⚠️  Index influencer-main-index not found in uppy_influencer, using scan...')
        usedScan = true
        try {
          console.log(`🔍 Scanning uppy_influencer for id_influencer_main: ${idInfluencerMain}`)
          const scanResult = await dynamoDB.send(new ScanCommand({
            TableName: 'uppy_influencer',
            FilterExpression: 'id_influencer_main = :idInfluencerMain',
            ExpressionAttributeValues: {
              ':idInfluencerMain': idInfluencerMain
            }
          }))

          console.log(`📊 Scan result: ${scanResult.Items?.length || 0} items found`)
          if (scanResult.Items && scanResult.Items.length > 0) {
            userInfluencerIds = scanResult.Items.map(item => item.id_influencer)
            console.log(`✅ User id_influencer_main ${idInfluencerMain} has ${userInfluencerIds.length} social profiles (via scan):`, userInfluencerIds)
          } else {
            console.warn(`⚠️  Scan returned 0 items for id_influencer_main ${idInfluencerMain}`)
          }
        } catch (scanError) {
          console.error(`❌ Scan error: ${scanError.name} - ${scanError.message}`)
        }
      } else {
        console.error('❌ Error querying uppy_influencer:', error)
      }
    }

    // Comparar el id_influencer del enrollment con los perfiles del usuario
    // El enrollment puede estar atado a:
    // 1. Un id_influencer (perfil social específico)
    // 2. Un id_influencer_main (la persona - enrollment creado con el ID incorrecto)
    const hasAccessViaSocialProfile = userInfluencerIds.includes(enrollment.id_influencer)
    const hasAccessViaMainProfile = enrollment.id_influencer === idInfluencerMain
    const hasAccess = hasAccessViaSocialProfile || hasAccessViaMainProfile

    if (userInfluencerIds.length === 0) {
      console.warn(`⚠️  No social profiles found for id_influencer_main ${idInfluencerMain}, checking direct id_influencer_main match...`)
    }
    
    console.log(`🔍 Access verification for enrollment ${enrollmentId}:`)
    console.log(`  - User id_influencer_main: ${idInfluencerMain}`)
    console.log(`  - User social profiles (id_influencer): ${userInfluencerIds.join(', ')}`)
    console.log(`  - Enrollment id_influencer: ${enrollment.id_influencer}`)
    console.log(`  - Access via social profile: ${hasAccessViaSocialProfile}`)
    console.log(`  - Access via main profile (legacy): ${hasAccessViaMainProfile}`)
    console.log(`  - Access granted: ${hasAccess}`)

    return hasAccess
  } catch (error) {
    // Si es un error de credenciales de AWS, permitir acceso con warning (solo para desarrollo)
    if (error.name === 'UnrecognizedClientException' ||
      error.message?.includes('security token') ||
      error.message?.includes('invalid')) {
      console.warn('⚠️  AWS credential error. Allowing access temporarily for development.')
      return true
    }

    console.error('Error verifying influencer access:', error)
    return false
  }
}

