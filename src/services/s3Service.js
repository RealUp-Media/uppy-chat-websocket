import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { v4 as uuidv4 } from 'uuid'

// Cliente S3
const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1'
})

const BUCKET_NAME = process.env.CAMPAIGN_MESSAGES_BUCKET || 'uppy-campaign-messages'
const CHAT_FILES_BUCKET = process.env.CHAT_FILES_BUCKET || BUCKET_NAME

/**
 * Sanitiza un string para usarlo en metadatos de S3
 * S3 metadata solo acepta caracteres ASCII imprimibles (0x20-0x7E)
 * @param {string} str - String a sanitizar
 * @returns {string} String sanitizado
 */
function sanitizeMetadata(str) {
  if (!str) return ''
  // Convertir a string y reemplazar caracteres no-ASCII con su equivalente ASCII o '_'
  return String(str)
    .replace(/[\u2018\u2019]/g, "'") // Reemplazar apóstrofes tipográficos con apóstrofe normal
    .replace(/[\u201C\u201D]/g, '"') // Reemplazar comillas tipográficas con comillas normales
    .replace(/[^\x20-\x7E]/g, '_') // Reemplazar cualquier otro carácter no-ASCII con '_'
    .substring(0, 255) // Limitar longitud (S3 metadata tiene límite de 2KB total)
}

/**
 * Obtiene un mensaje UI desde S3
 * @param {string} s3Key - Key del objeto en S3 (ej: "campaign-flows/campaign-id/steps/step-id/message.json")
 * @returns {Promise<object|null>} Mensaje UI o null si no existe
 */
export async function getMessageFromS3(s3Key) {
  try {
    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: s3Key
    })

    const response = await s3Client.send(command)
    
    // Leer el body como string
    const bodyString = await response.Body.transformToString()
    
    // Parsear JSON
    const message = JSON.parse(bodyString)
    
    return message
  } catch (error) {
    if (error.name === 'NoSuchKey' || error.code === 'NoSuchKey') {
      console.warn(`⚠️  Mensaje no encontrado en S3: ${s3Key}`)
      return null
    }
    
    if (error.name === 'UnrecognizedClientException' || error.message?.includes('security token')) {
      console.warn('⚠️  Error de credenciales AWS al obtener mensaje de S3.')
      return null
    }
    
    console.error(`Error obteniendo mensaje de S3 (${s3Key}):`, error)
    throw error
  }
}

/**
 * Carga mensajes UI para un paso desde S3 si tiene ui_message_s3_key
 * @param {object} step - Paso del flujo (puede tener ui_message_s3_key o ui_message)
 * @returns {Promise<object>} Paso con ui_message cargado desde S3 si aplica
 */
export async function loadStepMessage(step) {
  // Si ya tiene ui_message, retornar tal cual
  if (step.ui_message) {
    return step
  }
  
  // Si tiene ui_message_s3_key, cargar desde S3
  if (step.ui_message_s3_key) {
    try {
      const message = await getMessageFromS3(step.ui_message_s3_key)
      if (message) {
        const stepWithMessage = { ...step }
        stepWithMessage.ui_message = message
        // Mantener también el s3_key por si se necesita
        return stepWithMessage
      }
    } catch (error) {
      console.error(`Error cargando mensaje para paso ${step.step_id}:`, error)
      // Continuar sin el mensaje si falla la carga
    }
  }
  
  // Si no tiene ni ui_message ni ui_message_s3_key, retornar tal cual
  return step
}

/**
 * Carga mensajes UI para todos los pasos de un flujo
 * @param {Array} steps - Array de pasos del flujo
 * @returns {Promise<Array>} Array de pasos con mensajes cargados
 */
export async function loadFlowMessages(steps) {
  if (!steps || !Array.isArray(steps)) {
    return steps
  }
  
  // Cargar mensajes en paralelo para todos los pasos
  const stepsWithMessages = await Promise.all(
    steps.map(step => loadStepMessage(step))
  )
  
  return stepsWithMessages
}

/**
 * Sube un archivo a S3 para el chat
 * @param {Buffer} fileBuffer - Buffer del archivo
 * @param {string} originalName - Nombre original del archivo
 * @param {string} mimeType - Tipo MIME del archivo
 * @param {string} enrollmentId - ID del enrollment (conversación)
 * @returns {Promise<{s3Key: string, url: string}>} Key de S3 y URL del archivo
 */
export async function uploadChatFile(fileBuffer, originalName, mimeType, enrollmentId) {
  try {
    // Obtener extensión del archivo
    const fileExtension = originalName.split('.').pop().toLowerCase()
    
    // Generar nombre único para el archivo
    const fileId = uuidv4()
    const fileName = `${fileId}.${fileExtension}`
    
    // Crear key en S3: chat-files/enrollment-id/message-id/filename
    const s3Key = `chat-files/${enrollmentId}/${fileName}`
    
    // Sanitizar metadatos - S3 metadata solo acepta ASCII imprimible
    const sanitizedOriginalName = sanitizeMetadata(originalName)
    const sanitizedEnrollmentId = sanitizeMetadata(enrollmentId)
    
    console.log(`📤 Subiendo archivo a S3: ${s3Key}`)
    console.log(`   Bucket: ${CHAT_FILES_BUCKET}`)
    console.log(`   Tamaño: ${(fileBuffer.length / 1024).toFixed(2)} KB`)
    console.log(`   Tipo: ${mimeType}`)
    console.log(`   Nombre original: ${originalName} -> ${sanitizedOriginalName}`)
    
    // Subir archivo a S3
    const command = new PutObjectCommand({
      Bucket: CHAT_FILES_BUCKET,
      Key: s3Key,
      Body: fileBuffer,
      ContentType: mimeType,
      Metadata: {
        originalName: sanitizedOriginalName,
        enrollmentId: sanitizedEnrollmentId,
        uploadedAt: new Date().toISOString()
      }
    })
    
    await s3Client.send(command)
    console.log(`✅ Archivo subido exitosamente a S3: ${s3Key}`)
    
    // Construir URL del archivo (puede ser una URL pública o presignada)
    // Por ahora retornamos el key, el frontend puede construir la URL o usar presigned URL
    const url = `s3://${CHAT_FILES_BUCKET}/${s3Key}`
    
    return {
      s3Key,
      url,
      fileName: originalName, // Mantener el nombre original sin sanitizar para el frontend
      fileSize: fileBuffer.length,
      mimeType
    }
  } catch (error) {
    // Manejar diferentes tipos de errores de AWS
    if (error.name === 'UnrecognizedClientException' || error.message?.includes('security token')) {
      console.error('❌ Error de credenciales AWS al subir archivo a S3.')
      console.error('   Verifica que AWS_ACCESS_KEY_ID y AWS_SECRET_ACCESS_KEY estén configurados correctamente.')
      throw new Error('Error de credenciales AWS: Verifica tus credenciales en las variables de entorno')
    }
    
    if (error.name === 'SignatureDoesNotMatch' || error.Code === 'SignatureDoesNotMatch') {
      console.error('❌ Error de firma AWS (SignatureDoesNotMatch)')
      console.error('   Esto generalmente significa:')
      console.error('   1. Las credenciales AWS_SECRET_ACCESS_KEY es incorrecta o no coincide con AWS_ACCESS_KEY_ID')
      console.error('   2. Las credenciales han sido rotadas y necesitas actualizar tu .env')
      console.error('   3. Hay un problema con caracteres especiales en los metadatos (ya sanitizados)')
      console.error(`   Access Key ID usado: ${error.AWSAccessKeyId || 'N/A'}`)
      console.error(`   Bucket intentado: ${CHAT_FILES_BUCKET}`)
      console.error(`   Región: ${process.env.AWS_REGION || 'us-east-1'}`)
      console.error('   💡 Solución: Verifica que AWS_SECRET_ACCESS_KEY en tu .env sea correcto y completo')
      throw new Error('Error de autenticación AWS: Verifica que AWS_SECRET_ACCESS_KEY sea correcto y completo')
    }
    
    if (error.name === 'NoSuchBucket' || error.Code === 'NoSuchBucket') {
      console.error(`❌ El bucket ${CHAT_FILES_BUCKET} no existe`)
      throw new Error(`El bucket S3 ${CHAT_FILES_BUCKET} no existe. Verifica la configuración.`)
    }
    
    if (error.name === 'AccessDenied' || error.Code === 'AccessDenied') {
      console.error('❌ Acceso denegado al bucket S3')
      console.error('   Las credenciales no tienen permisos para escribir en el bucket')
      throw new Error('Acceso denegado: Las credenciales no tienen permisos para escribir en S3')
    }
    
    console.error('❌ Error subiendo archivo a S3:', error)
    console.error('   Detalles:', {
      name: error.name,
      code: error.Code,
      message: error.message,
      bucket: CHAT_FILES_BUCKET,
      region: process.env.AWS_REGION || 'us-east-1'
    })
    throw error
  }
}

/**
 * Obtiene un archivo del chat desde S3
 * @param {string} s3Key - Key del archivo en S3
 * @returns {Promise<{buffer: Buffer, contentType: string, metadata: object}>} Buffer del archivo y metadatos
 */
export async function getChatFile(s3Key) {
  try {
    const command = new GetObjectCommand({
      Bucket: CHAT_FILES_BUCKET,
      Key: s3Key
    })

    const response = await s3Client.send(command)
    
    // Leer el body como buffer
    const chunks = []
    for await (const chunk of response.Body) {
      chunks.push(chunk)
    }
    const buffer = Buffer.concat(chunks)
    
    return {
      buffer,
      contentType: response.ContentType,
      metadata: response.Metadata || {},
      contentLength: response.ContentLength
    }
  } catch (error) {
    if (error.name === 'NoSuchKey' || error.code === 'NoSuchKey') {
      console.warn(`⚠️  Archivo no encontrado en S3: ${s3Key}`)
      return null
    }
    
    if (error.name === 'UnrecognizedClientException' || error.message?.includes('security token')) {
      console.warn('⚠️  Error de credenciales AWS al obtener archivo de S3.')
      return null
    }
    
    console.error(`Error obteniendo archivo de S3 (${s3Key}):`, error)
    throw error
  }
}

/**
 * Genera una URL presignada para acceder a un archivo del chat
 * @param {string} s3Key - Key del archivo en S3
 * @param {number} expiresIn - Tiempo de expiración en segundos (default: 3600 = 1 hora)
 * @returns {Promise<string>} URL presignada
 */
export async function getChatFilePresignedUrl(s3Key, expiresIn = 3600) {
  try {
    const command = new GetObjectCommand({
      Bucket: CHAT_FILES_BUCKET,
      Key: s3Key
    })

    const url = await getSignedUrl(s3Client, command, { expiresIn })
    return url
  } catch (error) {
    if (error.name === 'UnrecognizedClientException' || error.message?.includes('security token')) {
      console.warn('⚠️  Error de credenciales AWS al generar URL presignada.')
      throw new Error('Error de credenciales AWS')
    }
    
    console.error(`Error generando URL presignada para ${s3Key}:`, error)
    throw error
  }
}

