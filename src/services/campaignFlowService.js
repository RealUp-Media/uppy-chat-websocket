import { dynamoDB, GetCommand, PutCommand, QueryCommand } from './dynamodb.js'
import { loadFlowMessages, loadStepMessage } from './s3Service.js'

const TABLE_NAME = 'uppy_campaign_flow'

/**
 * Obtiene el flujo completo de una campaña
 * @param {string} campaignId - ID de la campaña
 * @param {boolean} loadMessages - Si true, carga los mensajes desde S3 (default: true)
 * @returns {Promise<object|null>} Flujo de la campaña o null si no existe
 */
export async function getCampaignFlow(campaignId, loadMessages = true) {
  try {
    const result = await dynamoDB.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        id_campaign: campaignId  // La tabla usa id_campaign como partition key
      }
    }))

    if (!result.Item) {
      return null
    }

    const flow = result.Item

    // Cargar mensajes desde S3 si se solicita
    if (loadMessages && flow.steps) {
      flow.steps = await loadFlowMessages(flow.steps)
    }

    return flow
  } catch (error) {
    if (error.name === 'UnrecognizedClientException' || error.message?.includes('security token')) {
      console.warn('⚠️  Error de credenciales AWS al obtener flujo de campaña.')
      return null
    }
    console.error('Error obteniendo flujo de campaña:', error)
    throw error
  }
}

/**
 * Obtiene un paso específico por su step_id
 * @param {string} campaignId - ID de la campaña
 * @param {string} stepId - ID del paso
 * @param {boolean} loadMessage - Si true, carga el mensaje desde S3 (default: true)
 * @returns {Promise<object|null>} Paso encontrado o null
 */
export async function getStepById(campaignId, stepId, loadMessage = true) {
  try {
    const flow = await getCampaignFlow(campaignId, loadMessage)
    if (!flow || !flow.steps) {
      return null
    }

    const step = flow.steps.find(step => step.step_id === stepId)
    
    // Si no se cargaron mensajes antes, cargar solo este paso
    if (step && loadMessage && !step.ui_message && step.ui_message_s3_key) {
      return await loadStepMessage(step)
    }
    
    return step || null
  } catch (error) {
    console.error('Error obteniendo paso por ID:', error)
    throw error
  }
}

/**
 * Obtiene el paso inicial (order: 1)
 * @param {string} campaignId - ID de la campaña
 * @returns {Promise<object|null>} Paso inicial o null
 */
export async function getInitialStep(campaignId) {
  try {
    const flow = await getCampaignFlow(campaignId)
    if (!flow || !flow.steps) {
      return null
    }

    // Ordenar por order y obtener el primero
    const sortedSteps = flow.steps.sort((a, b) => (a.order || 0) - (b.order || 0))
    return sortedSteps[0] || null
  } catch (error) {
    console.error('Error obteniendo paso inicial:', error)
    throw error
  }
}

/**
 * Obtiene un paso por su número de orden
 * @param {string} campaignId - ID de la campaña
 * @param {number} order - Número de orden del paso
 * @returns {Promise<object|null>} Paso encontrado o null
 */
export async function getStepByOrder(campaignId, order) {
  try {
    const flow = await getCampaignFlow(campaignId)
    if (!flow || !flow.steps) {
      return null
    }

    return flow.steps.find(step => step.order === order) || null
  } catch (error) {
    console.error('Error obteniendo paso por orden:', error)
    throw error
  }
}

/**
 * Determina el siguiente paso según la transición
 * @param {string} campaignId - ID de la campaña
 * @param {string} currentStepId - ID del paso actual
 * @param {string} transitionKey - Clave de transición (button_id para ACTION_BUTTONS, o 'on_complete' para otros tipos)
 * @returns {Promise<object|null>} Siguiente paso o null si no existe
 */
export async function getNextStep(campaignId, currentStepId, transitionKey) {
  try {
    const currentStep = await getStepById(campaignId, currentStepId)
    if (!currentStep) {
      console.warn(`Paso actual ${currentStepId} no encontrado en campaña ${campaignId}`)
      return null
    }

    let nextStepId = null

    // Si tiene transitions, usar transitions (para pasos tipo ACTION_BUTTONS)
    if (currentStep.transitions) {
      // Buscar la transición (case-insensitive)
      const normalizedKey = transitionKey.toLowerCase()
      // Crear un mapa normalizado de transiciones
      const normalizedTransitions = {}
      for (const [key, value] of Object.entries(currentStep.transitions)) {
        normalizedTransitions[key.toLowerCase()] = value
      }
      
      // Buscar la transición normalizada
      nextStepId = normalizedTransitions[normalizedKey] || currentStep.transitions[transitionKey]
    }
    // Si es INPUT_URL o UPLOAD_FILES, usar on_complete
    else if (currentStep.on_complete) {
      nextStepId = currentStep.on_complete
    }

    if (!nextStepId) {
      console.warn(`No se encontró transición para ${transitionKey} en paso ${currentStepId}`)
      console.warn(`Transiciones disponibles:`, Object.keys(currentStep.transitions || {}))
      return null
    }

    // Validar que el siguiente paso existe
    const nextStep = await getStepById(campaignId, nextStepId)
    if (!nextStep) {
      console.warn(`Paso siguiente ${nextStepId} no existe en campaña ${campaignId}`)
      return null
    }

    return nextStep
  } catch (error) {
    console.error('Error obteniendo siguiente paso:', error)
    throw error
  }
}

/**
 * Crea o actualiza un flujo de campaña
 * @param {string} campaignId - ID de la campaña
 * @param {Array} steps - Array de pasos del flujo
 * @returns {Promise<object>} Flujo creado/actualizado
 */
export async function createOrUpdateCampaignFlow(campaignId, steps) {
  try {
    // Validar que todos los pasos tengan order único
    const orders = steps.map(s => s.order).filter(o => o != null)
    const uniqueOrders = new Set(orders)
    if (orders.length !== uniqueOrders.size) {
      throw new Error('Los pasos deben tener valores de order únicos')
    }

    // Validar que todos los step_id sean únicos
    const stepIds = steps.map(s => s.step_id).filter(id => id != null)
    const uniqueStepIds = new Set(stepIds)
    if (stepIds.length !== uniqueStepIds.size) {
      throw new Error('Los pasos deben tener step_id únicos')
    }

    const now = new Date().toISOString()
    const flow = {
      id_campaign: campaignId,  // La tabla usa id_campaign como partition key
      steps: steps,
      updated_at: now
    }

    // Si no existe, agregar created_at
    const existing = await getCampaignFlow(campaignId)
    if (!existing) {
      flow.created_at = now
    }

    await dynamoDB.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: flow
    }))

    return flow
  } catch (error) {
    if (error.name === 'UnrecognizedClientException' || error.message?.includes('security token')) {
      console.warn('⚠️  Error de credenciales AWS al crear/actualizar flujo.')
      throw error
    }
    console.error('Error creando/actualizando flujo de campaña:', error)
    throw error
  }
}

/**
 * Verifica si un step_id es un estado final predeterminado
 * Estados finales: COMPLETED (completa campaña), REJECTED (rechaza campaña)
 * @param {string} stepId - ID del paso
 * @returns {boolean} true si es estado final
 */
export function isFinalStep(stepId) {
  return stepId && (stepId === 'COMPLETED' || stepId === 'REJECTED')
}

