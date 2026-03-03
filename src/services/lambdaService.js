/**
 * Servicio para invocar lambdas directamente usando AWS SDK
 * 
 * Todas las lambdas se invocan directamente por ARN usando el SDK de AWS
 */

import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda'

const AWS_REGION = process.env.AWS_REGION || 'us-east-1'

// Nombres de funciones Lambda
const LAMBDA_FUNCTION_NAMES = {
  BEDROCK_AI_RESPONSE: process.env.LAMBDA_FUNCTION_BEDROCK_AI || 'uppy_websocket_ai_response',
  // Agregar más funciones aquí cuando crees nuevas lambdas
}

// Cliente Lambda
const lambdaClient = new LambdaClient({
  region: AWS_REGION
})

// Log de configuración al cargar el módulo
console.log('🔧 LambdaService configurado:')
console.log(`   - Región: ${AWS_REGION}`)
console.log(`   - Función Bedrock AI: ${LAMBDA_FUNCTION_NAMES.BEDROCK_AI_RESPONSE}`)

/**
 * Invoca una lambda directamente usando AWS SDK
 * 
 * @param {string} functionName - Nombre de la función Lambda
 * @param {object} payload - Payload a enviar
 * @returns {Promise<object>} Respuesta de la lambda
 */
export async function invokeLambda(functionName, payload) {
  try {
    console.log(`🔷 Invocando lambda: ${functionName}`)
    console.log(`🔷 Payload:`, JSON.stringify(payload).substring(0, 200) + '...')
    
    const command = new InvokeCommand({
      FunctionName: functionName,
      InvocationType: 'RequestResponse', // Síncrono
      Payload: JSON.stringify(payload)
    })

    const response = await lambdaClient.send(command)
    console.log(`🔷 Lambda invocada, status: ${response.StatusCode}`)
    console.log(`🔷 Response Payload type:`, typeof response.Payload)
    console.log(`🔷 Response Payload is Buffer?:`, Buffer.isBuffer(response.Payload))
    
    // Decodificar la respuesta
    let responsePayload
    try {
      const payloadString = new TextDecoder().decode(response.Payload)
      console.log(`🔷 Payload string (first 500 chars):`, payloadString.substring(0, 500))
      responsePayload = JSON.parse(payloadString)
    } catch (parseError) {
      console.error(`❌ Error parseando respuesta de lambda:`, parseError)
      console.error(`❌ Payload raw:`, response.Payload)
      throw new Error(`Error parseando respuesta de lambda: ${parseError.message}`)
    }

    // Logging detallado
    const responseStr = JSON.stringify(responsePayload)
    console.log(`🔷 Respuesta de lambda (raw):`, responseStr.substring(0, 500))
    console.log(`🔷 Tipo de respuesta:`, typeof responsePayload)
    console.log(`🔷 Es array?:`, Array.isArray(responsePayload))
    console.log(`🔷 Keys del objeto:`, Object.keys(responsePayload || {}))
    console.log(`🔷 Tiene statusCode?:`, responsePayload?.statusCode)
    console.log(`🔷 Tiene ai_response?:`, !!responsePayload?.ai_response)
    console.log(`🔷 Valor de ai_response:`, responsePayload?.ai_response ? responsePayload.ai_response.substring(0, 50) + '...' : 'NO EXISTE')

    // PRIORIDAD 1: Si tiene ai_response, es exitosa (independientemente de otros campos)
    if (responsePayload?.ai_response) {
      console.log(`✅ Respuesta exitosa con ai_response - Retornando respuesta`)
      return responsePayload
    }

    // PRIORIDAD 2: Si hay un error explícito con statusCode >= 400
    if (responsePayload?.statusCode && responsePayload.statusCode >= 400) {
      const errorMsg = responsePayload.error || responsePayload.message || responsePayload.body || 'Error en la lambda'
      const fullError = responsePayload.message ? `${errorMsg} - ${responsePayload.message}` : errorMsg
      console.error(`❌ Lambda retornó error (${responsePayload.statusCode}):`, fullError)
      console.error(`❌ Error completo:`, JSON.stringify(responsePayload, null, 2))
      throw new Error(fullError)
    }

    // Si no tiene ai_response ni statusCode de error, puede ser un formato inesperado
    console.warn(`⚠️ Respuesta sin ai_response ni statusCode de error:`, responsePayload)
    
    // Retornar directamente la respuesta (ya viene parseada)
    return responsePayload
  } catch (error) {
    console.error(`❌ Error invocando lambda ${functionName}:`, error)
    console.error(`❌ Error details:`, {
      name: error.name,
      message: error.message,
      code: error.code,
      stack: error.stack
    })
    throw error
  }
}

/**
 * Genera respuesta de IA usando Bedrock
 * 
 * @param {string} conversationId - ID de la conversación
 * @param {string} messageText - Texto del mensaje del influencer
 * @param {Array} conversationHistory - Historial de mensajes (opcional)
 * @param {object} influencerContext - Contexto adicional (opcional)
 * @param {object} flowContext - Contexto del flujo de campaña (opcional)
 * @returns {Promise<string>} Respuesta generada por IA
 */
export async function generateAIResponse(conversationId, messageText, conversationHistory = [], influencerContext = {}, flowContext = null) {
  try {
    console.log(`🤖 generateAIResponse llamado para conversación: ${conversationId}`)
    
    const payload = {
      conversation_id: conversationId,
      message_text: messageText,
      conversation_history: conversationHistory,
      influencer_context: influencerContext,
      flow_context: flowContext
    }

    const response = await invokeLambda(LAMBDA_FUNCTION_NAMES.BEDROCK_AI_RESPONSE, payload)
    console.log(`🤖 Respuesta recibida de lambda:`, response)
    
    if (response.ai_response) {
      return response.ai_response
    } else {
      console.error(`❌ Respuesta no contiene ai_response:`, response)
      throw new Error('Respuesta de lambda no contiene ai_response')
    }
  } catch (error) {
    console.error('❌ Error generando respuesta de IA:', error)
    console.error('❌ Stack trace:', error.stack)
    throw error
  }
}

