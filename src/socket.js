import { Server } from 'socket.io'
import { socketAuthMiddleware } from './middleware/socketAuth.js'
import { saveMessage, getConversationHistory, verifyInfluencerAccess } from './services/chatService.js'
import { generateAIResponse } from './services/lambdaService.js'
import { getCampaignFlow, getStepById, getNextStep, isFinalStep } from './services/campaignFlowService.js'
import { getEnrollment, updateEnrollmentStep } from './services/enrollmentService.js'
import { getMessageFromS3 } from './services/s3Service.js'

let ioInstance = null

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
            // Construir el texto del mensaje
            const messageText = messageData.text || ''
            
            // Construir botones
            let buttons = []
            
            // Si el mensaje ya tiene botones, usarlos
            if (messageData.buttons && Array.isArray(messageData.buttons)) {
              buttons = messageData.buttons
            }
            // Si no, construir botones desde las transiciones del paso
            else if (nextStep.transitions) {
              // Construir botones basados en las transiciones
              for (const [actionId, nextStepId] of Object.entries(nextStep.transitions)) {
                let label = actionId
                
                // Intentar obtener el label del mensaje en S3
                if (actionId.toLowerCase() === 'accept' && messageData.accept_button_label) {
                  label = messageData.accept_button_label
                } else if (actionId.toLowerCase() === 'reject' && messageData.reject_button_label) {
                  label = messageData.reject_button_label
                }
                
                buttons.push({
                  id: actionId.toLowerCase(),
                  label: label,
                  action: actionId.toLowerCase()
                })
              }
            }
            
            // Guardar mensaje en DynamoDB
            const savedMessage = await saveMessage({
              conversationId: enrollment_id,
              senderId: 'system',
              senderType: 'system',
              senderUsername: 'Sistema',
              messageText: messageText
            })
            
            // Crear payload del mensaje con botones
            const messagePayload = {
              message_id: savedMessage.message_id,
              conversation_id: enrollment_id,
              sender_id: 'system',
              sender_type: 'system',
              sender_username: 'Sistema',
              message_text: messageText,
              message_type: 'campaign_flow_step',
              step_id: nextStep.step_id,
              campaign_id: enrollment.id_campaign,
              buttons: buttons,
              created_at: savedMessage.created_at
            }
            
            // Enviar mensaje a todos en la conversación
            io.to(room).emit('new_message', messagePayload)
            console.log(`📨 Mensaje del siguiente paso enviado: ${nextStep.step_id} con ${buttons.length} botones`)
          } catch (error) {
            console.error('Error guardando/enviando mensaje del siguiente paso:', error)
            // Continuar aunque falle el guardado del mensaje
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
        if (user.role === 'influencer') {
          // Procesar transición de flujo si aplica
          try {
            const enrollment = await getEnrollment(enrollment_id)
            if (enrollment && enrollment.id_campaign && enrollment.current_step_id) {
              const currentStep = await getStepById(enrollment.id_campaign, enrollment.current_step_id)
              
              // Si el paso actual es INPUT_URL o UPLOAD_FILES, avanzar automáticamente
              if (currentStep && (currentStep.type === 'INPUT_URL' || currentStep.type === 'UPLOAD_FILES')) {
                if (currentStep.on_complete) {
                  const nextStep = await getNextStep(enrollment.id_campaign, enrollment.current_step_id, 'on_complete')
                  if (nextStep && !isFinalStep(nextStep.step_id)) {
                    await updateEnrollmentStep(enrollment_id, nextStep.step_id)
                    console.log(`🔄 Flujo avanzado automáticamente: ${enrollment_id} -> ${nextStep.step_id}`)
                    
                    // Notificar cambio de paso
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
              
              // Guardar respuesta de IA en DynamoDB
              const aiMessage = await saveMessage({
                conversationId: enrollment_id,
                senderId: 'ai-assistant',
                senderType: 'ai',
                senderUsername: 'AI Assistant',
                messageText: aiResponseText
              })
              
              // Obtener botones del paso actual si existen
              let buttons = []
              if (flowContext && flowContext.current_step && flowContext.current_step.message) {
                const currentStepMessage = flowContext.current_step.message
                
                // Si el mensaje tiene botones directamente
                if (currentStepMessage.buttons && Array.isArray(currentStepMessage.buttons)) {
                  buttons = currentStepMessage.buttons
                }
                // Si no, construir botones desde las transiciones
                else if (flowContext.current_step.transitions) {
                  for (const [actionId, nextStepId] of Object.entries(flowContext.current_step.transitions)) {
                    let label = actionId
                    
                    // Intentar obtener el label del mensaje
                    if (actionId.toLowerCase() === 'accept' && currentStepMessage.accept_button_label) {
                      label = currentStepMessage.accept_button_label
                    } else if (actionId.toLowerCase() === 'reject' && currentStepMessage.reject_button_label) {
                      label = currentStepMessage.reject_button_label
                    }
                    
                    buttons.push({
                      id: actionId.toLowerCase(),
                      label: label,
                      action: actionId.toLowerCase()
                    })
                  }
                }
              }
              
              // Crear payload del mensaje de IA
              const aiMessagePayload = {
                message_id: aiMessage.message_id,
                conversation_id: enrollment_id,
                sender_id: 'ai-assistant',
                sender_type: 'ai',
                sender_username: aiMessage.sender_username || 'AI Assistant',
                message_text: aiResponseText,
                created_at: aiMessage.created_at
              }
              
              // Agregar botones si existen
              if (buttons.length > 0) {
                aiMessagePayload.buttons = buttons
                aiMessagePayload.message_type = 'campaign_flow_step'
                aiMessagePayload.step_id = flowContext?.current_step_id
                aiMessagePayload.campaign_id = flowContext?.campaign_id
                console.log(`🔘 Botones agregados al mensaje de IA: ${buttons.length} botones`)
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
