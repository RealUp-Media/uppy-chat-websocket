import { Server } from 'socket.io'
import { socketAuthMiddleware } from './middleware/socketAuth.js'
import { saveMessage, getConversationHistory, verifyInfluencerAccess } from './services/chatService.js'

export function initSocket(server) {
  const io = new Server(server, {
    cors: {
      origin: process.env.CORS_ORIGIN || '*',
      credentials: true
    }
  })

  // Aplicar middleware de autenticación
  io.use(socketAuthMiddleware())

  // Almacenar conexiones activas por usuario
  const userConnections = new Map() // userId -> Set<socketId>
  const socketUsers = new Map() // socketId -> userInfo

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
          socket.emit('error', { 
            message: 'Access denied: Invalid influencer configuration' 
          })
          return
        }
        try {
          const hasAccess = await verifyInfluencerAccess(enrollment_id, user.id_influencer_main)
          if (!hasAccess) {
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
     * Enviar un mensaje
     */
    socket.on('send_message', async (data) => {
      const { enrollment_id, message_text } = data

      if (!enrollment_id || !message_text) {
        socket.emit('error', { message: 'enrollment_id and message_text are required' })
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
          socket.emit('error', { 
            message: 'Access denied: Invalid influencer configuration' 
          })
          return
        }
        try {
          const hasAccess = await verifyInfluencerAccess(enrollment_id, user.id_influencer_main)
          if (!hasAccess) {
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
          messageText: message_text
        })

        // Crear objeto de mensaje para enviar
        const messagePayload = {
          message_id: message.message_id,
          conversation_id: enrollment_id,
          sender_id: user.sub,
          sender_type: user.role,
          sender_username: user.username,
          message_text: message_text,
          created_at: message.created_at
        }

        // Enviar el mensaje a todos en la conversación
        io.to(room).emit('new_message', messagePayload)

        console.log(`📨 Mensaje enviado en ${enrollment_id} por ${user.username}`)
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
