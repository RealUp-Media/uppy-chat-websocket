// IMPORTANTE: Cargar dotenv PRIMERO antes de cualquier otra importación
// que pueda depender de variables de entorno
import { config } from 'dotenv'
config({ override: true })

import express from 'express'
import http from 'http'
import { initSocket } from './socket.js'
import cors from 'cors'
import multer from 'multer'
import { restAuthMiddleware } from './middleware/restAuth.js'
import { getEnrollment, updateEnrollmentStatus, updateEnrollmentStep } from './services/enrollmentService.js'
import { saveMessage, getConversationHistory, verifyInfluencerAccess, getStepSubmissions } from './services/chatService.js'
import { getCampaignFlow, getNextStep, isFinalStep, getStepById } from './services/campaignFlowService.js'
import { uploadChatFile, getChatFilePresignedUrl, getMessageFromS3 } from './services/s3Service.js'
import { getIO, buildStepUiPayload } from './socket.js'

/**
 * Valida si un archivo (por mimeType) cumple con allowed_types del paso upload.
 * @param {string} mimeType - ej: 'image/jpeg', 'video/mp4'
 * @param {string} allowedTypes - 'image' | 'video' | 'both'
 * @returns {boolean}
 */
function isUploadAllowedForStep(mimeType, allowedTypes) {
  if (!mimeType) return false
  const isImage = /^image\//.test(mimeType)
  const isVideo = /^video\//.test(mimeType)
  if (allowedTypes === 'image') return isImage
  if (allowedTypes === 'video') return isVideo
  if (allowedTypes === 'both') return isImage || isVideo
  return false
}

/**
 * Valida si un archivo puede subirse para el paso actual (solo si es tipo upload).
 * @returns {Promise<{valid: boolean, error?: string}>}
 */
async function validateUploadForStep(enrollmentId, mimeType) {
  try {
    const enrollment = await getEnrollment(enrollmentId)
    const campaignId = enrollment?.id_campaign || enrollment?.campaign_id
    if (!campaignId || !enrollment?.current_step_id) return { valid: true }

    const currentStep = await getStepById(campaignId, enrollment.current_step_id)
    if (!currentStep) return { valid: true }

    let messageData = currentStep.ui_message
    if (!messageData && currentStep.ui_message_s3_key) {
      messageData = await getMessageFromS3(currentStep.ui_message_s3_key)
    }
    const stepType = messageData?.step_type || currentStep.step_type
    if (stepType !== 'upload') return { valid: true }

    const allowedTypes = messageData?.allowed_types || 'both'
    if (!isUploadAllowedForStep(mimeType, allowedTypes)) {
      return { valid: false, error: `Tipo de archivo no permitido. Este paso acepta: ${allowedTypes}` }
    }
    return { valid: true }
  } catch (err) {
    console.error('Error validando upload para paso:', err)
    return { valid: true }
  }
}

/**
 * Avanza el flujo si el paso actual es tipo upload (el archivo ya fue validado).
 * @returns {Promise<{advanced: boolean, nextStep?: object, previousStepId?: string}>}
 */
async function advanceFlowAfterUpload(enrollmentId) {
  try {
    const enrollment = await getEnrollment(enrollmentId)
    const campaignId = enrollment?.id_campaign || enrollment?.campaign_id
    console.log('📤 advanceFlowAfterUpload:', { enrollmentId, hasEnrollment: !!enrollment, campaignId, current_step_id: enrollment?.current_step_id })
    if (!campaignId || !enrollment?.current_step_id) {
      console.log('📤 advanceFlowAfterUpload: saliendo (sin campaign o sin current_step_id)')
      return { advanced: false }
    }

    const currentStep = await getStepById(campaignId, enrollment.current_step_id)
    console.log('📤 advanceFlowAfterUpload currentStep:', { hasStep: !!currentStep, ui_message: !!currentStep?.ui_message, ui_message_s3_key: currentStep?.ui_message_s3_key })
    if (!currentStep) {
      console.log('📤 advanceFlowAfterUpload: saliendo (currentStep null)')
      return { advanced: false }
    }

    let messageData = currentStep.ui_message
    if (!messageData && currentStep.ui_message_s3_key) {
      messageData = await getMessageFromS3(currentStep.ui_message_s3_key)
      console.log('📤 advanceFlowAfterUpload messageData desde S3:', messageData)
    }
    const stepType = messageData?.step_type || currentStep.step_type
    console.log('📤 advanceFlowAfterUpload stepType:', stepType)
    if (stepType !== 'upload') {
      console.log('📤 advanceFlowAfterUpload: saliendo (stepType no es upload)')
      return { advanced: false }
    }

    const nextStep = await getNextStep(campaignId, enrollment.current_step_id, 'submit')
    console.log('📤 advanceFlowAfterUpload nextStep:', nextStep?.step_id)
    if (!nextStep) {
      console.log('📤 advanceFlowAfterUpload: saliendo (nextStep null)')
      return { advanced: false }
    }

    const previousStepId = enrollment.current_step_id
    await updateEnrollmentStep(enrollmentId, nextStep.step_id)
    console.log('📤 advanceFlowAfterUpload: ✅ avanzado a', nextStep.step_id)
    return { advanced: true, nextStep, previousStepId }
  } catch (err) {
    console.error('Error avanzando flujo tras upload:', err)
    return { advanced: false }
  }
}

const app = express()
const server = http.createServer(app)

app.use(cors())
app.use(express.json())
app.use(express.static('public'))

// Configurar multer para manejar archivos
const storage = multer.memoryStorage()
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB máximo
  },
  fileFilter: (req, file, cb) => {
    // Tipos de archivo permitidos
    const allowedMimeTypes = [
      'image/jpeg',
      'image/jpg',
      'image/png',
      'application/pdf',
      'video/mp4',
      'video/quicktime' // mov
    ]
    
    // También validar por extensión
    const allowedExtensions = ['jpg', 'jpeg', 'png', 'pdf', 'mp4', 'mov']
    const fileExtension = file.originalname.split('.').pop().toLowerCase()
    
    if (allowedMimeTypes.includes(file.mimetype) && allowedExtensions.includes(fileExtension)) {
      cb(null, true)
    } else {
      cb(new Error(`Tipo de archivo no permitido. Solo se permiten: ${allowedExtensions.join(', ')}`), false)
    }
  }
})

app.get('/health', (_, res) => {
  res.json({ status: 'ok' })
})

// Rutas API protegidas con autenticación
const apiRouter = express.Router()
apiRouter.use(restAuthMiddleware())

/**
 * GET /api/campaigns/:campaignId/flow
 * Obtiene la configuración del flujo de una campaña (JSON completo con steps y ui_message)
 * Para uso del frontend o lambdas que necesiten el flujo configurado.
 */
apiRouter.get('/campaigns/:campaignId/flow', async (req, res) => {
  try {
    const { campaignId } = req.params
    const loadMessages = req.query.load_messages !== 'false'

    const flow = await getCampaignFlow(campaignId, loadMessages)

    if (!flow) {
      return res.status(404).json({
        error: 'Not found',
        message: `Campaign flow not found for campaign_id: ${campaignId}`
      })
    }

    // Añadir campaign_id para consistencia (la tabla usa id_campaign)
    const response = { ...flow, campaign_id: flow.id_campaign || campaignId }

    res.json(response)
  } catch (error) {
    console.error('Error obteniendo flujo de campaña:', error)
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    })
  }
})

/**
 * GET /api/campaigns/:campaignId/submissions
 * Obtiene todas las entregas (inputs y uploads) de influencers por paso.
 * Query: ?step_id=ASK_CONTENT_LINK (opcional) para filtrar por paso.
 * Para dashboards que muestran qué subió cada influencer en cada paso.
 */
apiRouter.get('/campaigns/:campaignId/submissions', restAuthMiddleware, async (req, res) => {
  try {
    const { campaignId } = req.params
    const { step_id: stepId } = req.query
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500)

    const submissions = await getStepSubmissions(campaignId, stepId || null, limit)

    res.json({
      campaign_id: campaignId,
      step_id: stepId || null,
      submissions,
      count: submissions.length
    })
  } catch (error) {
    console.error('Error obteniendo entregas de campaña:', error)
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    })
  }
})

/**
 * GET /api/enrollments/:enrollmentId
 * Obtiene un enrollment por su ID
 */
apiRouter.get('/enrollments/:enrollmentId', async (req, res) => {
  try {
    const { enrollmentId } = req.params
    const user = req.user

    // Verificar acceso para influencers
    if (user.role === 'influencer') {
      if (!user.id_influencer_main) {
        return res.status(403).json({ 
          error: 'Access denied', 
          message: 'Invalid influencer configuration' 
        })
      }
      
      const hasAccess = await verifyInfluencerAccess(enrollmentId, user.id_influencer_main)
      if (!hasAccess) {
        return res.status(403).json({ 
          error: 'Access denied', 
          message: 'You do not have access to this enrollment' 
        })
      }
    }

    const enrollment = await getEnrollment(enrollmentId)
    
    if (!enrollment) {
      return res.status(404).json({ 
        error: 'Not found', 
        message: `Enrollment ${enrollmentId} not found` 
      })
    }

    res.json({
      success: true,
      enrollment
    })
  } catch (error) {
    console.error('Error obteniendo enrollment:', error)
    res.status(500).json({ 
      error: 'Internal server error', 
      message: error.message 
    })
  }
})

/**
 * POST /api/enrollments/:enrollmentId/messages
 * Envía un mensaje en la conversación del enrollment
 */
apiRouter.post('/enrollments/:enrollmentId/messages', async (req, res) => {
  try {
    const { enrollmentId } = req.params
    const { message_text } = req.body
    const user = req.user

    if (!message_text || !message_text.trim()) {
      return res.status(400).json({ 
        error: 'Bad request', 
        message: 'message_text is required' 
      })
    }

    // Verificar acceso para influencers
    if (user.role === 'influencer') {
      if (!user.id_influencer_main) {
        return res.status(403).json({ 
          error: 'Access denied', 
          message: 'Invalid influencer configuration' 
        })
      }
      
      const hasAccess = await verifyInfluencerAccess(enrollmentId, user.id_influencer_main)
      if (!hasAccess) {
        return res.status(403).json({ 
          error: 'Access denied', 
          message: 'You do not have access to this enrollment' 
        })
      }
    }

    // Guardar mensaje
    const message = await saveMessage({
      conversationId: enrollmentId,
      senderId: user.sub,
      senderType: user.role,
      senderUsername: user.username,
      messageText: message_text.trim()
    })

    // Si es un influencer, procesar flujo si aplica
    if (user.role === 'influencer') {
      try {
        const enrollment = await getEnrollment(enrollmentId)
        if (enrollment && enrollment.id_campaign && enrollment.current_step_id) {
          const currentStep = await getStepById(enrollment.id_campaign, enrollment.current_step_id)
          
          // Si el paso actual es INPUT_URL o UPLOAD_FILES, avanzar automáticamente
          if (currentStep && (currentStep.type === 'INPUT_URL' || currentStep.type === 'UPLOAD_FILES')) {
            if (currentStep.on_complete) {
              const nextStep = await getNextStep(enrollment.id_campaign, enrollment.current_step_id, 'on_complete')
              if (nextStep && !isFinalStep(nextStep.step_id)) {
                await updateEnrollmentStep(enrollmentId, nextStep.step_id)
                console.log(`🔄 Flujo avanzado automáticamente: ${enrollmentId} -> ${nextStep.step_id}`)
              }
            }
          }
        }
      } catch (flowError) {
        console.error('Error procesando flujo:', flowError)
        // No fallar el flujo si hay error, solo loguear
      }
    }

    res.json({
      success: true,
      message: {
        message_id: message.message_id,
        conversation_id: enrollmentId,
        sender_id: user.sub,
        sender_type: user.role,
        sender_username: message.sender_username || user.username,
        message_text: message_text.trim(),
        created_at: message.created_at
      }
    })
  } catch (error) {
    console.error('Error enviando mensaje:', error)
    res.status(500).json({ 
      error: 'Internal server error', 
      message: error.message 
    })
  }
})

/**
 * POST /api/enrollments/:enrollmentId/upload
 * Sube un archivo y lo adjunta a un mensaje en la conversación
 * Form data: file (archivo), message_text (opcional)
 */
apiRouter.post('/enrollments/:enrollmentId/upload', upload.single('file'), async (req, res) => {
  try {
    const { enrollmentId } = req.params
    const { message_text } = req.body
    const user = req.user

    if (!req.file) {
      return res.status(400).json({ 
        error: 'Bad request', 
        message: 'file is required' 
      })
    }

    // Verificar acceso para influencers
    if (user.role === 'influencer') {
      if (!user.id_influencer_main) {
        return res.status(403).json({ 
          error: 'Access denied', 
          message: 'Invalid influencer configuration' 
        })
      }
      
      const hasAccess = await verifyInfluencerAccess(enrollmentId, user.id_influencer_main)
      if (!hasAccess) {
        return res.status(403).json({ 
          error: 'Access denied', 
          message: 'You do not have access to this enrollment' 
        })
      }
    }

    // Si es influencer y el paso actual es upload, validar tipo de archivo antes de guardar
    if (user.role === 'influencer') {
      const validation = await validateUploadForStep(enrollmentId, req.file.mimetype)
      if (!validation.valid) {
        return res.status(400).json({
          error: 'Bad request',
          message: validation.error
        })
      }
    }

    // Subir archivo a S3
    const fileInfo = await uploadChatFile(
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype,
      enrollmentId
    )

    // Obtener enrollment para taggear con step_id si es influencer en flujo de campaña
    let flowData = null
    if (user.role === 'influencer') {
      const enrollment = await getEnrollment(enrollmentId)
      if (enrollment?.id_campaign && enrollment?.current_step_id) {
        flowData = {
          message_type: 'user_step_submission',
          step_id: enrollment.current_step_id,
          campaign_id: enrollment.id_campaign
        }
      }
    }

    // Guardar mensaje con archivo adjunto (incluye step_id para dashboard de entregas)
    const message = await saveMessage({
      conversationId: enrollmentId,
      senderId: user.sub,
      senderType: user.role,
      senderUsername: user.username,
      messageText: message_text?.trim() || null,
      attachments: [fileInfo],
      flowData
    })

    // Crear payload del mensaje
    const messagePayload = {
      message_id: message.message_id,
      conversation_id: enrollmentId,
      sender_id: user.sub,
      sender_type: user.role,
      sender_username: message.sender_username || user.username,
      message_text: message_text?.trim() || null,
      attachments: message.attachments || [],
      created_at: message.created_at
    }

    // Emitir evento de socket para notificar a todos en la conversación
    const io = getIO()
    if (io) {
      const room = `conversation:${enrollmentId}`
      io.to(room).emit('new_message', messagePayload)
      console.log(`📎 Archivo enviado en ${enrollmentId} por ${user.username} (rol: ${user.role})`)
    }

    // Si es influencer y el paso actual es tipo upload, avanzar flujo
    if (user.role === 'influencer') {
      const flowResult = await advanceFlowAfterUpload(enrollmentId)
      if (flowResult.advanced && flowResult.nextStep && io) {
        const room = `conversation:${enrollmentId}`
        const enrollment = await getEnrollment(enrollmentId)
        const campaignId = enrollment?.id_campaign || enrollment?.campaign_id

        // Cargar y emitir mensaje del siguiente paso (para que el frontend muestre el nuevo UI)
        let nextMessageData = flowResult.nextStep.ui_message
        if (!nextMessageData && flowResult.nextStep.ui_message_s3_key) {
          try {
            nextMessageData = await getMessageFromS3(flowResult.nextStep.ui_message_s3_key)
          } catch (s3Error) {
            console.error('Error cargando mensaje del siguiente paso desde S3:', s3Error)
          }
        }

        if (nextMessageData) {
          try {
            const messageText = nextMessageData.text || ''
            const uiPayload = buildStepUiPayload(nextMessageData, flowResult.nextStep)

            const savedMessage = await saveMessage({
              conversationId: enrollmentId,
              senderId: 'system',
              senderType: 'system',
              senderUsername: 'Sistema',
              messageText: messageText,
              flowData: {
                message_type: 'campaign_flow_step',
                step_id: flowResult.nextStep.step_id,
                campaign_id: campaignId,
                ...uiPayload
              }
            })

            const messagePayload = {
              ...savedMessage,
              conversation_id: enrollmentId,
              message_type: 'campaign_flow_step',
              step_id: flowResult.nextStep.step_id,
              campaign_id: campaignId,
              ...uiPayload
            }

            io.to(room).emit('new_message', messagePayload)
            console.log(`📨 Mensaje del siguiente paso enviado tras upload: ${flowResult.nextStep.step_id} (tipo: ${uiPayload.step_type})`)
          } catch (error) {
            console.error('Error guardando/enviando mensaje del siguiente paso tras upload:', error)
          }
        }

        io.to(room).emit('flow_step_changed', {
          enrollment_id: enrollmentId,
          previous_step_id: flowResult.previousStepId,
          current_step_id: flowResult.nextStep.step_id,
          step: flowResult.nextStep
        })
        console.log(`🔄 Flujo avanzado tras upload: ${enrollmentId} -> ${flowResult.nextStep.step_id}`)
      }
    }

    res.json({
      success: true,
      message: messagePayload
    })
  } catch (error) {
    console.error('Error subiendo archivo:', error)
    
    // Si es error de multer (validación de archivo)
    if (error.message && error.message.includes('Tipo de archivo no permitido')) {
      return res.status(400).json({ 
        error: 'Bad request', 
        message: error.message 
      })
    }
    
    res.status(500).json({ 
      error: 'Internal server error', 
      message: error.message 
    })
  }
})

/**
 * GET /api/enrollments/:enrollmentId/files/:s3Key/url
 * Obtiene una URL presignada para acceder a un archivo del chat
 * Query params: expiresIn (opcional, en segundos, default: 3600)
 */
apiRouter.get('/enrollments/:enrollmentId/files/:s3Key/url', async (req, res) => {
  try {
    const { enrollmentId, s3Key } = req.params
    const { expiresIn } = req.query
    const user = req.user

    // Verificar acceso para influencers
    if (user.role === 'influencer') {
      if (!user.id_influencer_main) {
        return res.status(403).json({ 
          error: 'Access denied', 
          message: 'Invalid influencer configuration' 
        })
      }
      
      const hasAccess = await verifyInfluencerAccess(enrollmentId, user.id_influencer_main)
      if (!hasAccess) {
        return res.status(403).json({ 
          error: 'Access denied', 
          message: 'You do not have access to this enrollment' 
        })
      }
    }

    // Verificar que el archivo pertenece a este enrollment
    if (!s3Key.startsWith(`chat-files/${enrollmentId}/`)) {
      return res.status(403).json({ 
        error: 'Access denied', 
        message: 'File does not belong to this enrollment' 
      })
    }

    const expiresInSeconds = expiresIn ? parseInt(expiresIn, 10) : 3600
    const url = await getChatFilePresignedUrl(s3Key, expiresInSeconds)

    res.json({
      success: true,
      url,
      expiresIn: expiresInSeconds
    })
  } catch (error) {
    console.error('Error obteniendo URL presignada:', error)
    res.status(500).json({ 
      error: 'Internal server error', 
      message: error.message 
    })
  }
})

/**
 * PUT /api/enrollments/:enrollmentId/status
 * Actualiza el estado del enrollment según la respuesta del influenciador
 * Body: { status: 'accepted' | 'rejected' | 'in_progress' | 'completed' | 'cancelled', action_id?: string }
 */
apiRouter.put('/enrollments/:enrollmentId/status', async (req, res) => {
  try {
    const { enrollmentId } = req.params
    const { status, action_id } = req.body
    const user = req.user

    if (!status) {
      return res.status(400).json({ 
        error: 'Bad request', 
        message: 'status is required' 
      })
    }

    // Verificar acceso para influencers
    if (user.role === 'influencer') {
      if (!user.id_influencer_main) {
        return res.status(403).json({ 
          error: 'Access denied', 
          message: 'Invalid influencer configuration' 
        })
      }
      
      const hasAccess = await verifyInfluencerAccess(enrollmentId, user.id_influencer_main)
      if (!hasAccess) {
        return res.status(403).json({ 
          error: 'Access denied', 
          message: 'You do not have access to this enrollment' 
        })
      }
    }

    // Obtener enrollment actual
    const enrollment = await getEnrollment(enrollmentId)
    if (!enrollment) {
      return res.status(404).json({ 
        error: 'Not found', 
        message: `Enrollment ${enrollmentId} not found` 
      })
    }

    // Si se proporciona action_id, procesar transición de flujo
    let nextStepId = null
    if (action_id && enrollment.id_campaign && enrollment.current_step_id) {
      try {
        const nextStep = await getNextStep(enrollment.id_campaign, enrollment.current_step_id, action_id)
        if (nextStep) {
          nextStepId = nextStep.step_id
          
          // Actualizar el paso del enrollment
          await updateEnrollmentStep(enrollmentId, nextStepId)
          
          // Si es un paso final, actualizar el estado automáticamente
          if (isFinalStep(nextStepId)) {
            // Determinar estado basado en el step_id final
            // Solo hay dos estados finales predeterminados: REJECTED y COMPLETED
            let finalStatus = status
            if (nextStepId === 'REJECTED') {
              finalStatus = 'rejected'
            } else if (nextStepId === 'COMPLETED') {
              finalStatus = 'completed'
            }
            
            // Actualizar estado del enrollment
            const updatedEnrollment = await updateEnrollmentStatus(enrollmentId, finalStatus)
            
            return res.json({
              success: true,
              enrollment: updatedEnrollment,
              flow_updated: true,
              previous_step_id: enrollment.current_step_id,
              current_step_id: nextStepId,
              status_updated: true,
              final_status: finalStatus
            })
          }
        }
      } catch (flowError) {
        console.error('Error procesando transición de flujo:', flowError)
        // Continuar con la actualización de estado aunque falle el flujo
      }
    }

    // Actualizar estado del enrollment
    const updatedEnrollment = await updateEnrollmentStatus(enrollmentId, status, {
      current_step_id: nextStepId || enrollment.current_step_id
    })

    res.json({
      success: true,
      enrollment: updatedEnrollment,
      flow_updated: !!nextStepId,
      previous_step_id: enrollment.current_step_id,
      current_step_id: nextStepId || enrollment.current_step_id
    })
  } catch (error) {
    console.error('Error actualizando estado del enrollment:', error)
    res.status(500).json({ 
      error: 'Internal server error', 
      message: error.message 
    })
  }
})

app.use('/api', apiRouter)

initSocket(server)

const PORT = process.env.PORT || 3000
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`)
})

// Manejar señales de cierre correctamente (importante para Railway)
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server')
  server.close(() => {
    console.log('HTTP server closed')
    process.exit(0)
  })
})

process.on('SIGINT', () => {
  console.log('SIGINT signal received: closing HTTP server')
  server.close(() => {
    console.log('HTTP server closed')
    process.exit(0)
  })
})