import { Server } from 'socket.io'
import { socketAuthMiddleware } from './middleware/socketAuth.js'
import { saveMessage, getConversationHistory, verifyInfluencerAccess } from './services/chatService.js'
import { generateAIResponse } from './services/lambdaService.js'
import { getCampaignFlow, getStepById, getNextStep, isFinalStep } from './services/campaignFlowService.js'
import { getEnrollment, updateEnrollmentStep, updateEnrollmentAIStatus } from './services/enrollmentService.js'
import { getMessageFromS3 } from './services/s3Service.js'

let ioInstance = null

/**
 * Valida el valor ingresado por el usuario según las reglas de validación del paso.
 * @param {string} value - Valor a validar
 * @param {object} validation - Objeto de validación del paso (type, error_message)
 * @returns {string|null} Mensaje de error o null si es válido
 */
function validateInputValue(value, validation) {
  if (!value || !value.trim()) {
    return 'Este campo es requerido'
  }

  if (!validation || !validation.type || validation.type === 'text') {
    return null
  }

  const { type, error_message } = validation

  if (type === 'url') {
    try {
      new URL(value)
      return null
    } catch {
      return error_message || 'Por favor ingresa una URL válida (ej: https://...)'
    }
  }

  if (type === 'number') {
    if (value.trim() === '' || isNaN(Number(value))) {
      return error_message || 'Por favor ingresa solo números'
    }
    return null
  }

  if (type === 'email') {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(value)) {
      return error_message || 'Por favor ingresa un email válido'
    }
    return null
  }

  if (type === 'instagram_url') {
    const igRegex = /^https?:\/\/(www\.)?instagram\.com\//i
    if (!igRegex.test(value)) {
      return error_message || 'Por favor ingresa una URL de Instagram válida (https://www.instagram.com/...)'
    }
    return null
  }

  if (type === 'phone') {
    const phoneRegex = /^\+?[\d\s\-()\\.]{7,20}$/
    if (!phoneRegex.test(value)) {
      return error_message || 'Por favor ingresa un número de teléfono válido'
    }
    return null
  }

  return null
}

/**
 * Construye el bloque de UI para el payload de un mensaje de paso de campaña.
 *
 * Para pasos tipo 'buttons': retorna { step_type, buttons }.
 * Para pasos tipo 'input':   retorna { step_type, input_config }.
 *
 * @param {object} messageData - Datos del mensaje cargados desde S3
 * @param {object} step        - Paso del flujo (necesario para transitions en caso de fallback)
 * @returns {object} Objeto con step_type y el bloque de UI correspondiente
 */
function buildStepUiPayload(messageData, step) {
  const stepType = messageData?.step_type || 'buttons'

  if (stepType === 'input') {
    return {
      step_type: 'input',
      input_config: {
        placeholder: messageData.input_placeholder || '',
        submit_button_label: messageData.submit_button_label || 'Enviar',
        validation: messageData.validation || { type: 'text' }
      }
    }
  }

  if (stepType === 'upload') {
    return {
      step_type: 'upload',
      upload_config: {
        allowed_types: messageData.allowed_types || 'both',
        submit_button_label: messageData.submit_button_label || 'Enviar'
      }
    }
  }

  // Default: buttons
  let buttons = []

  if (messageData?.buttons && Array.isArray(messageData.buttons)) {
    buttons = messageData.buttons
  } else if (step?.transitions) {
    // Para step_type 'buttons' solo mostrar accept y reject (submit es para input/upload)
    const buttonActions = ['accept', 'reject']
    for (const [actionId] of Object.entries(step.transitions)) {
      const action = actionId.toLowerCase()
      if (!buttonActions.includes(action)) continue
      let label = actionId
      if (action === 'accept' && messageData?.accept_button_label) {
        label = messageData.accept_button_label
      } else if (action === 'reject' && messageData?.reject_button_label) {
        label = messageData.reject_button_label
      }
      buttons.push({ id: action, label, action })
    }
  }

  return { step_type: 'buttons', buttons }
}

export { buildStepUiPayload }
export function initSocket(server) {
  const io = new Server(server, {
    cors: {
      origin: process.env.CORS_ORIGIN || '*',
      credentials: true
    }
  })
  
  ioInstance = io

  // Aplicar middleware de autenticación (puede estar deshabilitado con DISABLE_AUTH=true)
  io.use(socketAuthMiddleware())

  // Almacenar conexiones activas por usuario
  const userConnections = new Map() // userId -> Set<socketId>
  const socketUsers = new Map() // socketId -> userInfo
  
  // Sistema de cooldown para respuestas de IA
  const aiCooldownTimers = new Map() // enrollment_id -> timeout
  const AI_COOLDOWN_MS = 5000 // 5 segundos de cooldown

  // Conversaciones con IA deshabilitada (sincronizado con DynamoDB)
  const aiDisabledConversations = new Set() // enrollment_id

  io.on('connection', async (socket) => {
    const user = socket.user
    
    // Registrar la conexión del usuario
    if (!userConnections.has(user.sub)) {
      userConnections.set(user.sub, new Set())
    }
    userConnections.get(user.sub).add(socket.id)
    socketUsers.set(socket.id, user)

    console.log(`🟢 Usuario conectado: ${user.username} (${user.role}) - ${socket.id}`)

    // Notificar al usuario que se conectó exitosamente
    socket.emit('authenticated', {
      user: {
        id: user.sub,
        email: user.email,
        role: user.role,
        username: user.username
      }
    })

    /**
     * Unirse a una conversación (room basado en enrollment_id)
     */
    socket.on('join_conversation', async ({ enrollment_id }) => {
      if (!enrollment_id) {
        socket.emit('error', { message: 'enrollment_id is required' })
        return
      }

      const room = `conversation:${enrollment_id}`
      
      // Verificar que el usuario tiene acceso a este enrollment
      if (user.role === 'influencer') {
        if (!user.id_influencer_main) {
          console.error(`❌ User ${user.username} (${user.sub}) missing id_influencer_main in token`)
          socket.emit('error', { 
            message: 'Access denied: Invalid influencer configuration' 
          })
          return
        }
        
        try {
          console.log(`🔐 Verifying access for user ${user.username} (id_influencer_main: ${user.id_influencer_main}) to enrollment ${enrollment_id}`)
          const hasAccess = await verifyInfluencerAccess(enrollment_id, user.id_influencer_main)
          if (!hasAccess) {
            console.warn(`❌ Access denied for user ${user.username} to enrollment ${enrollment_id}`)
            socket.emit('error', { 
              message: 'Access denied: You do not have access to this enrollment' 
            })
            return
          }
        } catch (error) {
          console.error('Error verifying influencer access:', error)
          socket.emit('error', { message: 'Error verifying access' })
          return
        }
      }

      socket.join(room)
      console.log(`👥 ${user.username} se unió a la conversación: ${enrollment_id}`)

      // Enviar confirmación
      socket.emit('joined_conversation', { enrollment_id })

      // Sincronizar estado de IA con DynamoDB
      try {
        const enrollment = await getEnrollment(enrollment_id)
        if (enrollment) {
          // ai_enabled es true por defecto si no está definido
          const aiEnabled = enrollment.ai_enabled !== false
          if (!aiEnabled) {
            aiDisabledConversations.add(enrollment_id)
          } else {
            aiDisabledConversations.delete(enrollment_id)
          }
          socket.emit('ai_status', { enrollment_id, ai_enabled: aiEnabled })
        }
      } catch (error) {
        console.warn('No se pudo sincronizar estado de IA:', error)
      }

      // Enviar historial de mensajes
      try {
        const history = await getConversationHistory(enrollment_id)
        socket.emit('conversation_history', {
          enrollment_id,
          messages: history.reverse() // Mostrar más antiguos primero
        })
      } catch (error) {
        console.error('Error fetching conversation history:', error)
        socket.emit('error', { message: 'Error loading conversation history' })
      }

      // Notificar a otros en la conversación que alguien se unió (opcional)
      socket.to(room).emit('user_joined', {
        user: {
          id: user.sub,
          username: user.username,
          role: user.role
        },
        enrollment_id
      })
    })

    /**
     * Salir de una conversación
     */
    socket.on('leave_conversation', ({ enrollment_id }) => {
      if (!enrollment_id) {
        socket.emit('error', { message: 'enrollment_id is required' })
        return
      }

      const room = `conversation:${enrollment_id}`
      socket.leave(room)
      socket.emit('left_conversation', { enrollment_id })
      console.log(`👋 ${user.username} salió de la conversación: ${enrollment_id}`)
    })

    /**
     * Manejar acción de botón (para pasos tipo ACTION_BUTTONS)
     */
    socket.on('flow_action', async (data) => {
      const { enrollment_id, action_id } = data

      if (!enrollment_id || !action_id) {
        socket.emit('error', { message: 'enrollment_id and action_id are required' })
        return
      }

      const room = `conversation:${enrollment_id}`

      // Verificar acceso
      if (user.role === 'influencer') {
        if (!user.id_influencer_main) {
          console.error(`❌ User ${user.username} (${user.sub}) missing id_influencer_main in token (flow_action)`)
          socket.emit('error', { message: 'Access denied: Invalid influencer configuration' })
          return
        }
        try {
          console.log(`🔐 Verifying access for flow_action - user ${user.username} (id_influencer_main: ${user.id_influencer_main}) to enrollment ${enrollment_id}`)
          const hasAccess = await verifyInfluencerAccess(enrollment_id, user.id_influencer_main)
          if (!hasAccess) {
            console.warn(`❌ Access denied for flow_action - user ${user.username} to enrollment ${enrollment_id}`)
            socket.emit('error', { message: 'Access denied' })
            return
          }
        } catch (error) {
          console.error('Error verifying access:', error)
          socket.emit('error', { message: 'Error verifying access' })
          return
        }
      }

      try {
        // Obtener enrollment y flujo
        const enrollment = await getEnrollment(enrollment_id)
        if (!enrollment) {
          socket.emit('error', { message: 'Enrollment not found' })
          return
        }

        if (!enrollment.id_campaign) {
          socket.emit('error', { message: 'Enrollment has no campaign_id' })
          return
        }

        if (!enrollment.current_step_id) {
          socket.emit('error', { message: 'Enrollment has no current_step_id' })
          return
        }

        // Obtener paso actual para saber qué botón fue presionado
        const currentStep = await getStepById(enrollment.id_campaign, enrollment.current_step_id)
        if (!currentStep) {
          socket.emit('error', { message: 'Current step not found' })
          return
        }

        // Obtener información del botón presionado
        let buttonLabel = action_id
        if (currentStep.ui_message && currentStep.ui_message.buttons) {
          const pressedButton = currentStep.ui_message.buttons.find(btn => 
            btn.id.toLowerCase() === action_id.toLowerCase()
          )
          if (pressedButton) {
            buttonLabel = pressedButton.label
          }
        }

        // Guardar mensaje del influenciador indicando qué botón presionó
        try {
          const userActionMessage = await saveMessage({
            conversationId: enrollment_id,
            senderId: user.sub,
            senderType: user.role,
            senderUsername: user.username,
            messageText: `[Acción: ${buttonLabel}]`
          })

          // Enviar el mensaje de acción del usuario
          const actionMessagePayload = {
            message_id: userActionMessage.message_id,
            conversation_id: enrollment_id,
            sender_id: user.sub,
            sender_type: user.role,
            sender_username: userActionMessage.sender_username || user.username,
            message_text: `[Acción: ${buttonLabel}]`,
            created_at: userActionMessage.created_at
          }

          io.to(room).emit('new_message', actionMessagePayload)
          console.log(`📝 Acción del influenciador guardada: ${buttonLabel}`)
        } catch (error) {
          console.error('Error guardando mensaje de acción del influenciador:', error)
          // Continuar aunque falle el guardado del mensaje
        }

        // Obtener siguiente paso
        const nextStep = await getNextStep(enrollment.id_campaign, enrollment.current_step_id, action_id)
        
        if (!nextStep) {
          socket.emit('error', { message: 'Invalid transition or step not found' })
          return
        }

        // Si es un paso final, no avanzar más
        if (isFinalStep(nextStep.step_id)) {
          console.log(`🏁 Flujo completado para ${enrollment_id}, estado final: ${nextStep.step_id}`)
        }

        // Actualizar enrollment con el nuevo paso
        await updateEnrollmentStep(enrollment_id, nextStep.step_id)

        // Cargar y enviar el mensaje del siguiente paso
        let messageData = null
        
        // Si ya tiene ui_message cargado, usarlo
        if (nextStep.ui_message) {
          messageData = nextStep.ui_message
        }
        // Si tiene ui_message_s3_key, cargar desde S3
        else if (nextStep.ui_message_s3_key) {
          try {
            messageData = await getMessageFromS3(nextStep.ui_message_s3_key)
          } catch (error) {
            console.error('Error cargando mensaje desde S3:', error)
          }
        }
        
        // Si tenemos datos del mensaje, enviarlo
        if (messageData) {
          try {
            const messageText = messageData.text || ''
            const uiPayload = buildStepUiPayload(messageData, nextStep)

            // Guardar mensaje en DynamoDB con todos los campos de flujo para que el historial los incluya
            const savedMessage = await saveMessage({
              conversationId: enrollment_id,
              senderId: 'system',
              senderType: 'system',
              senderUsername: 'Sistema',
              messageText: messageText,
              flowData: {
                message_type: 'campaign_flow_step',
                step_id: nextStep.step_id,
                campaign_id: enrollment.id_campaign,
                ...uiPayload
              }
            })

            // Emitir payload completo a todos en la conversación
            const messagePayload = {
              ...savedMessage,
              conversation_id: enrollment_id,
              message_type: 'campaign_flow_step',
              step_id: nextStep.step_id,
              campaign_id: enrollment.id_campaign,
              ...uiPayload
            }

            io.to(room).emit('new_message', messagePayload)
            console.log(`📨 Mensaje del siguiente paso enviado: ${nextStep.step_id} (tipo: ${uiPayload.step_type})`)
          } catch (error) {
            console.error('Error guardando/enviando mensaje del siguiente paso:', error)
          }
        } else {
          console.warn(`⚠️  No se pudo cargar el mensaje para el paso ${nextStep.step_id}`)
        }

        // Notificar cambio de paso
        socket.emit('flow_step_changed', {
          enrollment_id,
          previous_step_id: enrollment.current_step_id,
          current_step_id: nextStep.step_id,
          step: nextStep
        })

        console.log(`🔄 Flujo actualizado: ${enrollment_id} -> ${nextStep.step_id}`)
      } catch (error) {
        console.error('Error processing flow action:', error)
        socket.emit('error', { message: 'Error processing flow action' })
      }
    })

    /**
     * Manejar envío de input (para pasos tipo 'input')
     * Evento: flow_input
     * Payload: { enrollment_id, input_value }
     */
    socket.on('flow_input', async (data) => {
      const { enrollment_id, input_value } = data

      if (!enrollment_id || input_value === undefined || input_value === null) {
        socket.emit('error', { message: 'enrollment_id and input_value are required' })
        return
      }

      const room = `conversation:${enrollment_id}`

      // Verificar acceso
      if (user.role === 'influencer') {
        if (!user.id_influencer_main) {
          socket.emit('error', { message: 'Access denied: Invalid influencer configuration' })
          return
        }
        try {
          const hasAccess = await verifyInfluencerAccess(enrollment_id, user.id_influencer_main)
          if (!hasAccess) {
            socket.emit('error', { message: 'Access denied' })
            return
          }
        } catch (error) {
          console.error('Error verifying access:', error)
          socket.emit('error', { message: 'Error verifying access' })
          return
        }
      }

      try {
        // Obtener enrollment y paso actual
        const enrollment = await getEnrollment(enrollment_id)
        if (!enrollment) {
          socket.emit('error', { message: 'Enrollment not found' })
          return
        }

        if (!enrollment.id_campaign || !enrollment.current_step_id) {
          socket.emit('error', { message: 'Enrollment has no active campaign step' })
          return
        }

        const currentStep = await getStepById(enrollment.id_campaign, enrollment.current_step_id)
        if (!currentStep) {
          socket.emit('error', { message: 'Current step not found' })
          return
        }

        // Cargar datos del mensaje desde S3 para obtener la configuración de validación
        let messageData = currentStep.ui_message || null
        if (!messageData && currentStep.ui_message_s3_key) {
          try {
            messageData = await getMessageFromS3(currentStep.ui_message_s3_key)
          } catch (s3Error) {
            console.error('Error cargando mensaje desde S3:', s3Error)
          }
        }

        // Verificar que el paso actual es de tipo input
        const stepType = messageData?.step_type || currentStep.step_type || 'buttons'
        if (stepType !== 'input') {
          socket.emit('error', {
            message: `Current step '${currentStep.step_id}' is not an input step (type: '${stepType}'). Use 'flow_action' for button steps.`
          })
          return
        }

        // Validar el valor ingresado según las reglas del paso
        const validation = messageData?.validation
        const validationError = validateInputValue(String(input_value), validation)
        if (validationError) {
          socket.emit('input_validation_error', {
            enrollment_id,
            step_id: currentStep.step_id,
            error: validationError
          })
          return
        }

        // Guardar mensaje del usuario con el valor ingresado (incluye step_id para dashboard de entregas)
        const userMessage = await saveMessage({
          conversationId: enrollment_id,
          senderId: user.sub,
          senderType: user.role,
          senderUsername: user.username,
          messageText: String(input_value),
          flowData: {
            message_type: 'user_step_submission',
            step_id: currentStep.step_id,
            campaign_id: enrollment.id_campaign
          }
        })

        io.to(room).emit('new_message', {
          message_id: userMessage.message_id,
          conversation_id: enrollment_id,
          sender_id: user.sub,
          sender_type: user.role,
          sender_username: userMessage.sender_username || user.username,
          message_text: String(input_value),
          created_at: userMessage.created_at
        })

        console.log(`📝 Input del usuario guardado para paso ${currentStep.step_id}: ${String(input_value).substring(0, 80)}`)

        // Determinar siguiente paso usando la transición 'submit'
        const nextStep = await getNextStep(enrollment.id_campaign, enrollment.current_step_id, 'submit')

        if (!nextStep) {
          socket.emit('error', { message: "No 'submit' transition found for current step" })
          return
        }

        if (isFinalStep(nextStep.step_id)) {
          console.log(`🏁 Flujo completado para ${enrollment_id}, estado final: ${nextStep.step_id}`)
        }

        // Actualizar enrollment con el nuevo paso
        await updateEnrollmentStep(enrollment_id, nextStep.step_id)

        // Cargar mensaje del siguiente paso
        let nextMessageData = nextStep.ui_message || null
        if (!nextMessageData && nextStep.ui_message_s3_key) {
          try {
            nextMessageData = await getMessageFromS3(nextStep.ui_message_s3_key)
          } catch (s3Error) {
            console.error('Error cargando mensaje del siguiente paso desde S3:', s3Error)
          }
        }

        if (nextMessageData) {
          try {
            const messageText = nextMessageData.text || ''
            const uiPayload = buildStepUiPayload(nextMessageData, nextStep)

            // Guardar con todos los campos de flujo para que el historial los incluya
            const savedMessage = await saveMessage({
              conversationId: enrollment_id,
              senderId: 'system',
              senderType: 'system',
              senderUsername: 'Sistema',
              messageText: messageText,
              flowData: {
                message_type: 'campaign_flow_step',
                step_id: nextStep.step_id,
                campaign_id: enrollment.id_campaign,
                ...uiPayload
              }
            })

            const messagePayload = {
              ...savedMessage,
              conversation_id: enrollment_id,
              message_type: 'campaign_flow_step',
              step_id: nextStep.step_id,
              campaign_id: enrollment.id_campaign,
              ...uiPayload
            }

            io.to(room).emit('new_message', messagePayload)
            console.log(`📨 Mensaje del siguiente paso enviado: ${nextStep.step_id} (tipo: ${uiPayload.step_type})`)
          } catch (error) {
            console.error('Error guardando/enviando mensaje del siguiente paso:', error)
          }
        } else {
          console.warn(`⚠️  No se pudo cargar el mensaje para el paso ${nextStep.step_id}`)
        }

        // Notificar cambio de paso
        socket.emit('flow_step_changed', {
          enrollment_id,
          previous_step_id: enrollment.current_step_id,
          current_step_id: nextStep.step_id,
          step: nextStep
        })

        console.log(`🔄 Flujo actualizado por input: ${enrollment_id} -> ${nextStep.step_id}`)
      } catch (error) {
        console.error('Error processing flow input:', error)
        socket.emit('error', { message: 'Error processing flow input' })
      }
    })

    /**
     * Activar o desactivar respuestas de IA para una conversación
     * Solo permitido para usuarios con rol 'operations' o 'admin'
     * Evento: toggle_ai
     * Payload: { enrollment_id, ai_enabled: boolean }
     */
    socket.on('toggle_ai', async (data) => {
      const { enrollment_id, ai_enabled } = data

      if (!enrollment_id || typeof ai_enabled !== 'boolean') {
        socket.emit('error', { message: 'enrollment_id and ai_enabled (boolean) are required' })
        return
      }

      if (user.role !== 'operations' && user.role !== 'admin') {
        socket.emit('error', { message: 'Access denied: only operations or admin users can toggle AI' })
        return
      }

      const room = `conversation:${enrollment_id}`

      try {
        await updateEnrollmentAIStatus(enrollment_id, ai_enabled)

        if (ai_enabled) {
          aiDisabledConversations.delete(enrollment_id)
        } else {
          aiDisabledConversations.add(enrollment_id)
          // Cancelar cualquier respuesta IA pendiente para esta conversación
          if (aiCooldownTimers.has(enrollment_id)) {
            clearTimeout(aiCooldownTimers.get(enrollment_id))
            aiCooldownTimers.delete(enrollment_id)
            console.log(`⏹️  Respuesta IA cancelada por toggle para ${enrollment_id}`)
          }
        }

        // Notificar a todos en la conversación el cambio de estado
        io.to(room).emit('ai_status_changed', {
          enrollment_id,
          ai_enabled,
          toggled_by: user.username
        })

        console.log(`🤖 IA ${ai_enabled ? 'habilitada' : 'deshabilitada'} para ${enrollment_id} por ${user.username}`)
      } catch (error) {
        console.error('Error al cambiar estado de IA:', error)
        socket.emit('error', { message: 'Error updating AI status' })
      }
    })

    /**
     * Enviar un mensaje
     */
    socket.on('send_message', async (data) => {
      const { enrollment_id, message_text, attachments } = data

      if (!enrollment_id) {
        socket.emit('error', { message: 'enrollment_id is required' })
        return
      }

      // Debe tener al menos texto o archivos adjuntos
      if (!message_text && (!attachments || attachments.length === 0)) {
        socket.emit('error', { message: 'message_text or attachments are required' })
        return
      }

      const room = `conversation:${enrollment_id}`

      // Verificar que el socket está en la conversación
      if (!socket.rooms.has(room)) {
        socket.emit('error', { message: 'You must join the conversation first' })
        return
      }

      // Verificar acceso para influencers
      if (user.role === 'influencer') {
        if (!user.id_influencer_main) {
          console.error(`❌ User ${user.username} (${user.sub}) missing id_influencer_main in token (send_message)`)
          socket.emit('error', { 
            message: 'Access denied: Invalid influencer configuration' 
          })
          return
        }
        try {
          console.log(`🔐 Verifying access for send_message - user ${user.username} (id_influencer_main: ${user.id_influencer_main}) to enrollment ${enrollment_id}`)
          const hasAccess = await verifyInfluencerAccess(enrollment_id, user.id_influencer_main)
          if (!hasAccess) {
            console.warn(`❌ Access denied for send_message - user ${user.username} to enrollment ${enrollment_id}`)
            socket.emit('error', { 
              message: 'Access denied: You do not have access to this enrollment' 
            })
            return
          }
        } catch (error) {
          console.error('Error verifying influencer access:', error)
          socket.emit('error', { message: 'Error verifying access' })
          return
        }
      }

      try {
        // Guardar mensaje en DynamoDB
        const message = await saveMessage({
          conversationId: enrollment_id,
          senderId: user.sub,
          senderType: user.role,
          senderUsername: user.username,
          messageText: message_text || null,
          attachments: attachments || null
        })

        // Crear objeto de mensaje para enviar
        const messagePayload = {
          message_id: message.message_id,
          conversation_id: enrollment_id,
          sender_id: user.sub,
          sender_type: user.role,
          sender_username: message.sender_username || user.username,
          message_text: message_text || null,
          created_at: message.created_at
        }

        // Agregar archivos adjuntos si existen
        if (message.attachments && message.attachments.length > 0) {
          messagePayload.attachments = message.attachments
        }

        // Enviar el mensaje a todos en la conversación
        io.to(room).emit('new_message', messagePayload)

        console.log(`📨 Mensaje enviado en ${enrollment_id} por ${user.username} (rol: ${user.role})`)

        // Si es un influencer, procesar flujo y generar respuesta automática con IA
        if (user.role === 'influencer' && !aiDisabledConversations.has(enrollment_id)) {
          // Procesar transición de flujo si aplica
          try {
            const enrollment = await getEnrollment(enrollment_id)
            if (enrollment && enrollment.id_campaign && enrollment.current_step_id) {
              const currentStep = await getStepById(enrollment.id_campaign, enrollment.current_step_id)
              const stepType = currentStep?.ui_message?.step_type || currentStep?.step_type

              // Paso tipo upload: avanzar si hay attachments
              if (stepType === 'upload' && attachments && attachments.length > 0 && currentStep?.transitions?.submit) {
                const nextStep = await getNextStep(enrollment.id_campaign, enrollment.current_step_id, 'submit')
                if (nextStep) {
                  await updateEnrollmentStep(enrollment_id, nextStep.step_id)
                  console.log(`🔄 Flujo avanzado por upload (send_message): ${enrollment_id} -> ${nextStep.step_id}`)
                  socket.emit('flow_step_changed', {
                    enrollment_id,
                    previous_step_id: enrollment.current_step_id,
                    current_step_id: nextStep.step_id,
                    step: nextStep
                  })
                }
              }
              // Legacy: INPUT_URL o UPLOAD_FILES con on_complete
              else if (currentStep && (currentStep.type === 'INPUT_URL' || currentStep.type === 'UPLOAD_FILES')) {
                if (currentStep.on_complete) {
                  const nextStep = await getNextStep(enrollment.id_campaign, enrollment.current_step_id, 'on_complete')
                  if (nextStep && !isFinalStep(nextStep.step_id)) {
                    await updateEnrollmentStep(enrollment_id, nextStep.step_id)
                    console.log(`🔄 Flujo avanzado automáticamente: ${enrollment_id} -> ${nextStep.step_id}`)
                    socket.emit('flow_step_changed', {
                      enrollment_id,
                      previous_step_id: enrollment.current_step_id,
                      current_step_id: nextStep.step_id,
                      step: nextStep
                    })
                  }
                }
              }
            }
          } catch (flowError) {
            console.error('Error procesando flujo:', flowError)
            // No fallar el flujo si hay error en el flujo, solo loguear
          }
          // Cancelar timeout anterior si existe (si el usuario envía múltiples mensajes seguidos)
          if (aiCooldownTimers.has(enrollment_id)) {
            clearTimeout(aiCooldownTimers.get(enrollment_id))
            console.log(`⏸️  Cooldown anterior cancelado para ${enrollment_id}, esperando nuevo cooldown...`)
          }
          
          // Crear nuevo timeout con cooldown
          const timeoutId = setTimeout(async () => {
            // Limpiar el timer del mapa
            aiCooldownTimers.delete(enrollment_id)
            
            try {
              console.log(`🤖 Iniciando generación de respuesta IA para influencer en ${enrollment_id}`)
              console.log(`📚 Obteniendo historial de conversación para ${enrollment_id}`)
              
              // Obtener historial de conversación para contexto
              const allHistory = await getConversationHistory(enrollment_id, 15)
              
              // Filtrar el mensaje que acaba de enviar el influencer (el más reciente)
              // para evitar que la IA responda a un mensaje antiguo
              const history = allHistory.filter(msg => {
                // Excluir el mensaje actual del historial
                return !(msg.sender_id === user.sub && 
                        msg.message_text === message_text &&
                        msg.sender_type === user.role)
              })
              
              console.log(`📚 Historial obtenido: ${allHistory.length} mensajes totales, ${history.length} mensajes después de filtrar`)
              
              // Obtener el mensaje más reciente del influencer para responder
              const latestInfluencerMessage = allHistory
                .filter(msg => msg.sender_type === 'influencer')
                .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0]
              
              const messageToRespond = latestInfluencerMessage?.message_text || message_text
              
              console.log(`🚀 Invocando lambda de Bedrock para generar respuesta...`)
              
              // Obtener contexto del flujo para la IA (con mensajes de S3)
              let flowContext = null
              try {
                const enrollment = await getEnrollment(enrollment_id)
                if (enrollment && enrollment.id_campaign && enrollment.current_step_id) {
                  // Cargar flujo con mensajes desde S3
                  const flow = await getCampaignFlow(enrollment.id_campaign, true)
                  const currentStep = await getStepById(enrollment.id_campaign, enrollment.current_step_id, true)
                  
                  if (flow && currentStep) {
                    // Construir contexto con todos los pasos y sus mensajes
                    const stepsWithMessages = []
                    for (const step of flow.steps || []) {
                      const stepInfo = {
                        step_id: step.step_id,
                        order: step.order,
                        type: step.type,
                        transitions: step.transitions,
                        on_complete: step.on_complete
                      }
                      
                      // Si el paso tiene mensaje cargado, incluirlo
                      if (step.ui_message) {
                        stepInfo.message = {
                          text: step.ui_message.text || '',
                          buttons: step.ui_message.buttons || []
                        }
                      } else if (step.ui_message_s3_key) {
                        // Intentar cargar desde S3
                        try {
                          const messageData = await getMessageFromS3(step.ui_message_s3_key)
                          if (messageData) {
                            stepInfo.message = {
                              text: messageData.text || '',
                              buttons: messageData.buttons || [],
                              accept_button_label: messageData.accept_button_label,
                              reject_button_label: messageData.reject_button_label
                            }
                          }
                        } catch (s3Error) {
                          console.warn(`No se pudo cargar mensaje de S3 para paso ${step.step_id}:`, s3Error)
                        }
                      }
                      
                      stepsWithMessages.push(stepInfo)
                    }
                    
                    // Asegurar que el mensaje del paso actual esté cargado
                    let currentStepMessage = currentStep.ui_message
                    if (!currentStepMessage && currentStep.ui_message_s3_key) {
                      try {
                        currentStepMessage = await getMessageFromS3(currentStep.ui_message_s3_key)
                      } catch (s3Error) {
                        console.warn(`No se pudo cargar mensaje de S3 para paso actual ${currentStep.step_id}:`, s3Error)
                      }
                    }
                    
                    flowContext = {
                      campaign_id: enrollment.id_campaign,
                      current_step_id: enrollment.current_step_id,
                      current_step: {
                        step_id: currentStep.step_id,
                        order: currentStep.order,
                        type: currentStep.type,
                        transitions: currentStep.transitions,
                        on_complete: currentStep.on_complete,
                        message: currentStepMessage || null
                      },
                      flow_steps: stepsWithMessages
                    }
                    
                    console.log(`📋 Contexto de flujo construido con ${stepsWithMessages.length} pasos`)
                    console.log(`📋 Paso actual: ${enrollment.current_step_id}, tiene mensaje: ${!!currentStepMessage}`)
                  }
                }
              } catch (flowError) {
                console.warn('No se pudo obtener contexto de flujo para IA:', flowError)
                console.error('Error completo:', flowError.stack)
              }
              
              // Log del contexto antes de enviarlo
              if (flowContext) {
                console.log(`✅ FlowContext preparado:`, {
                  campaign_id: flowContext.campaign_id,
                  current_step_id: flowContext.current_step_id,
                  steps_count: flowContext.flow_steps?.length || 0
                })
              } else {
                console.warn(`⚠️ FlowContext es null - la IA no tendrá contexto del flujo`)
              }
              
              // Generar respuesta de IA usando Bedrock con contexto de flujo
              const aiResponseText = await generateAIResponse(
                enrollment_id,
                messageToRespond,
                history,
                {}, // influencerContext (vacío por ahora)
                flowContext // flowContext
              )
              console.log(`✅ Respuesta IA generada: ${aiResponseText.substring(0, 50)}...`)
              
              // Construir bloque de UI (buttons o input_config) del paso actual
              let uiPayload = null
              if (flowContext && flowContext.current_step && flowContext.current_step.message) {
                uiPayload = buildStepUiPayload(
                  flowContext.current_step.message,
                  flowContext.current_step
                )
              }

              // Guardar respuesta de IA en DynamoDB con campos de flujo para el historial
              const aiMessage = await saveMessage({
                conversationId: enrollment_id,
                senderId: 'ai-assistant',
                senderType: 'ai',
                senderUsername: 'AI Assistant',
                messageText: aiResponseText,
                flowData: uiPayload ? {
                  message_type: 'campaign_flow_step',
                  step_id: flowContext?.current_step_id,
                  campaign_id: flowContext?.campaign_id,
                  ...uiPayload
                } : undefined
              })

              // Crear payload del mensaje de IA
              const aiMessagePayload = {
                ...aiMessage,
                conversation_id: enrollment_id,
                ...(uiPayload && {
                  message_type: 'campaign_flow_step',
                  step_id: flowContext?.current_step_id,
                  campaign_id: flowContext?.campaign_id,
                  ...uiPayload
                })
              }

              if (uiPayload) {
                console.log(`🔘 UI payload agregado al mensaje de IA (tipo: ${uiPayload.step_type})`)
              }

              // Enviar respuesta de IA a la conversación
              io.to(room).emit('new_message', aiMessagePayload)
              console.log(`🤖 Respuesta IA generada y enviada para ${enrollment_id}`)
            } catch (error) {
              console.error('❌ Error generando respuesta IA:', error)
              console.error('Stack trace:', error.stack)
              // No fallar el flujo si la IA falla, solo loguear
              // El mensaje del influencer ya se guardó y envió correctamente
            }
          }, AI_COOLDOWN_MS)
          
          // Guardar el timeout en el mapa
          aiCooldownTimers.set(enrollment_id, timeoutId)
          console.log(`⏳ Cooldown iniciado para ${enrollment_id} (${AI_COOLDOWN_MS}ms)`)
        } else if (user.role === 'influencer' && aiDisabledConversations.has(enrollment_id)) {
          console.log(`ℹ️  IA deshabilitada para ${enrollment_id}, no se genera respuesta automática`)
        } else {
          console.log(`ℹ️  Usuario ${user.username} no es influencer (rol: ${user.role}), no se genera respuesta IA`)
        }
      } catch (error) {
        console.error('Error sending message:', error)
        socket.emit('error', { message: 'Error sending message' })
      }
    })

    /**
     * Manejar desconexión
     */
    socket.on('disconnect', () => {
      console.log(`🔴 Usuario desconectado: ${user.username} - ${socket.id}`)
      
      // Remover la conexión del usuario
      const userSockets = userConnections.get(user.sub)
      if (userSockets) {
        userSockets.delete(socket.id)
        if (userSockets.size === 0) {
          userConnections.delete(user.sub)
        }
      }
      socketUsers.delete(socket.id)
    })
  })

  return io
}

/**
 * Obtiene la instancia de Socket.IO para emitir eventos desde otros módulos
 * @returns {Server|null} Instancia de Socket.IO o null si no está inicializada
 */
export function getIO() {
  return ioInstance
}
