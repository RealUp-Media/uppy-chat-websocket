import { dynamoDB, GetCommand, PutCommand, UpdateCommand, QueryCommand } from './dynamodb.js'

const TABLE_NAME = 'uppy_enrollment'

/**
 * Obtiene un enrollment por su enrollment_id
 * @param {string} enrollmentId - ID del enrollment
 * @returns {Promise<object|null>} Enrollment o null si no existe
 */
export async function getEnrollment(enrollmentId) {
  try {
    // Intentar usar GSI primero
    const result = await dynamoDB.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'enrollment-id-index',
      KeyConditionExpression: 'enrollment_id = :enrollmentId',
      ExpressionAttributeValues: {
        ':enrollmentId': enrollmentId
      },
      Limit: 1
    }))

    if (result.Items && result.Items.length > 0) {
      return result.Items[0]
    }

    return null
  } catch (error) {
    // Si el índice no existe, intentar con Scan (fallback)
    if (error.name === 'ResourceNotFoundException' || error.message?.includes('index')) {
      console.warn('GSI enrollment-id-index no encontrado, usando método alternativo')
      // En este caso, necesitaríamos la partition key de la tabla
      // Por ahora retornamos null y el código que llama debe manejar esto
      return null
    }

    if (error.name === 'UnrecognizedClientException' || error.message?.includes('security token')) {
      console.warn('⚠️  Error de credenciales AWS al obtener enrollment.')
      return null
    }

    console.error('Error obteniendo enrollment:', error)
    throw error
  }
}

/**
 * Actualiza el current_step_id de un enrollment
 * @param {string} enrollmentId - ID del enrollment
 * @param {string} newStepId - Nuevo step_id
 * @returns {Promise<object>} Enrollment actualizado
 */
export async function updateEnrollmentStep(enrollmentId, newStepId) {
  try {
    const now = new Date().toISOString()

    // Nota: UpdateCommand requiere la partition key y sort key de la tabla
    // Como no tenemos acceso directo a esas keys desde enrollment_id,
    // necesitamos primero obtener el enrollment para tener sus keys
    const enrollment = await getEnrollment(enrollmentId)
    
    if (!enrollment) {
      throw new Error(`Enrollment ${enrollmentId} no encontrado`)
    }

    // Actualizar usando UpdateCommand
    // Necesitamos las keys de la tabla. Asumiendo que la tabla tiene una estructura
    // donde podemos usar algún campo como key. Por ahora, intentamos con UpdateCommand
    // usando el enrollment_id si es la partition key, o necesitamos otro método
    
    // Si enrollment_id es la partition key, podemos actualizar directamente
    // Si no, necesitamos usar otro enfoque (por ejemplo, PutCommand con el item completo)
    
    // La tabla tiene id_campaign (partition key) e id_influencer (sort key)
    // Asegurarse de que ambos estén presentes en el Item
    if (!enrollment.id_campaign || !enrollment.id_influencer) {
      throw new Error(`Enrollment ${enrollmentId} no tiene las claves primarias requeridas (id_campaign, id_influencer)`)
    }

    const updatedEnrollment = {
      ...enrollment,
      current_step_id: newStepId,
      updated_at: now,
      // Asegurar que las claves primarias estén presentes
      id_campaign: enrollment.id_campaign,
      id_influencer: enrollment.id_influencer
    }

    await dynamoDB.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: updatedEnrollment
    }))

    return updatedEnrollment
  } catch (error) {
    if (error.name === 'UnrecognizedClientException' || error.message?.includes('security token')) {
      console.warn('⚠️  Error de credenciales AWS al actualizar enrollment.')
      throw error
    }
    console.error('Error actualizando enrollment step:', error)
    throw error
  }
}

/**
 * Inicializa el current_step_id de un enrollment con el paso inicial de la campaña
 * @param {string} enrollmentId - ID del enrollment
 * @param {string} campaignId - ID de la campaña
 * @returns {Promise<object>} Enrollment actualizado
 */
export async function initializeEnrollmentStep(enrollmentId, campaignId) {
  try {
    const { getInitialStep } = await import('./campaignFlowService.js')
    const initialStep = await getInitialStep(campaignId)
    
    if (!initialStep) {
      throw new Error(`No se encontró paso inicial para la campaña ${campaignId}`)
    }

    return await updateEnrollmentStep(enrollmentId, initialStep.step_id)
  } catch (error) {
    console.error('Error inicializando enrollment step:', error)
    throw error
  }
}

/**
 * Activa o desactiva las respuestas automáticas de IA para un enrollment
 * @param {string} enrollmentId - ID del enrollment
 * @param {boolean} aiEnabled - true para habilitar IA, false para deshabilitarla
 * @returns {Promise<object>} Enrollment actualizado
 */
export async function updateEnrollmentAIStatus(enrollmentId, aiEnabled) {
  try {
    const now = new Date().toISOString()
    const enrollment = await getEnrollment(enrollmentId)

    if (!enrollment) {
      throw new Error(`Enrollment ${enrollmentId} no encontrado`)
    }

    if (!enrollment.id_campaign || !enrollment.id_influencer) {
      throw new Error(`Enrollment ${enrollmentId} no tiene las claves primarias requeridas`)
    }

    const updatedEnrollment = {
      ...enrollment,
      ai_enabled: aiEnabled,
      ai_status_updated_at: now,
      id_campaign: enrollment.id_campaign,
      id_influencer: enrollment.id_influencer
    }

    await dynamoDB.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: updatedEnrollment
    }))

    console.log(`🤖 Estado de IA actualizado para ${enrollmentId}: ${aiEnabled ? 'HABILITADA' : 'DESHABILITADA'}`)
    return updatedEnrollment
  } catch (error) {
    if (error.name === 'UnrecognizedClientException' || error.message?.includes('security token')) {
      console.warn('⚠️  Error de credenciales AWS al actualizar estado de IA.')
      throw error
    }
    console.error('Error actualizando estado de IA del enrollment:', error)
    throw error
  }
}

/**
 * Actualiza el estado de un enrollment según la respuesta del influenciador
 * @param {string} enrollmentId - ID del enrollment
 * @param {string} status - Nuevo estado (ej: 'pending', 'accepted', 'rejected', 'in_progress', 'completed')
 * @param {object} additionalData - Datos adicionales para actualizar (opcional)
 * @returns {Promise<object>} Enrollment actualizado
 */
export async function updateEnrollmentStatus(enrollmentId, status, additionalData = {}) {
  try {
    const now = new Date().toISOString()

    // Obtener el enrollment actual
    const enrollment = await getEnrollment(enrollmentId)
    
    if (!enrollment) {
      throw new Error(`Enrollment ${enrollmentId} no encontrado`)
    }

    // Validar estado
    const validStatuses = ['pending', 'accepted', 'rejected', 'in_progress', 'completed', 'cancelled']
    if (!validStatuses.includes(status)) {
      throw new Error(`Estado inválido: ${status}. Estados válidos: ${validStatuses.join(', ')}`)
    }

    // La tabla tiene id_campaign (partition key) e id_influencer (sort key)
    // Asegurarse de que ambos estén presentes en el Item
    if (!enrollment.id_campaign || !enrollment.id_influencer) {
      throw new Error(`Enrollment ${enrollmentId} no tiene las claves primarias requeridas (id_campaign, id_influencer)`)
    }

    // Actualizar enrollment con nuevo estado y datos adicionales
    const updatedEnrollment = {
      ...enrollment,
      status: status,
      updated_at: now,
      // Asegurar que las claves primarias estén presentes
      id_campaign: enrollment.id_campaign,
      id_influencer: enrollment.id_influencer,
      ...additionalData
    }

    await dynamoDB.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: updatedEnrollment
    }))

    console.log(`✅ Estado de enrollment actualizado: ${enrollmentId} -> ${status}`)
    return updatedEnrollment
  } catch (error) {
    if (error.name === 'UnrecognizedClientException' || error.message?.includes('security token')) {
      console.warn('⚠️  Error de credenciales AWS al actualizar estado del enrollment.')
      throw error
    }
    console.error('Error actualizando estado del enrollment:', error)
    throw error
  }
}

