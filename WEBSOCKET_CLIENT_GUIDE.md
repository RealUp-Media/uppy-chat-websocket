# Guía de Implementación WebSocket - Cliente Frontend

## Descripción General

Este WebSocket permite comunicación en tiempo real entre **influencers** y **personas de operaciones** basada en `enrollment_id`. Todas las conversaciones se guardan en DynamoDB en la tabla `uppy_chat_messages`.

## Autenticación

**IMPORTANTE**: Todas las conexiones requieren autenticación mediante un token JWT de AWS Cognito.

### Configuración de Conexión

```javascript
import { io } from 'socket.io-client'

// Obtener el token JWT de Cognito (esto depende de cómo manejas la autenticación en tu frontend)
const token = 'tu-jwt-token-de-cognito' // Por ejemplo: localStorage.getItem('idToken')

const socket = io('ws://localhost:3000', {
  auth: {
    token: token
  },
  // Opcional: también puedes enviarlo como header
  // extraHeaders: {
  //   Authorization: `Bearer ${token}`
  // }
})
```

**Nota**: El token debe ser un JWT válido emitido por AWS Cognito. El usuario debe pertenecer al grupo `influencer` o `operations` en Cognito.

## Eventos del Servidor → Cliente (Recibir)

### 1. `authenticated`
Se emite inmediatamente después de una conexión exitosa y autenticación válida.

```javascript
socket.on('authenticated', (data) => {
  console.log('Autenticado exitosamente:', data)
  // data = {
  //   user: {
  //     id: "64582498-9091-7029-1d34-45797ea85e5b", // sub de Cognito
  //     email: "juangomcal@gmail.com",
  //     role: "influencer" | "operations",
  //     username: "usuario123"
  //   }
  // }
})
```

### 2. `joined_conversation`
Confirmación de que te uniste exitosamente a una conversación.

```javascript
socket.on('joined_conversation', (data) => {
  console.log('Te uniste a la conversación:', data)
  // data = {
  //   enrollment_id: "9b7a28d8-ebae-44a7-b386-1894ba32357d"
  // }
})
```

### 3. `conversation_history`
Historial de mensajes de la conversación (se envía automáticamente al unirte).

```javascript
socket.on('conversation_history', (data) => {
  console.log('Historial de mensajes:', data)
  // data = {
  //   enrollment_id: "9b7a28d8-ebae-44a7-b386-1894ba32357d",
  //   messages: [
  //     {
  //       message_id: "uuid-del-mensaje",
  //       conversation_id: "9b7a28d8-ebae-44a7-b386-1894ba32357d",
  //       sender_id: "64582498-9091-7029-1d34-45797ea85e5b",
  //       sender_type: "influencer" | "operations",
  //       sender_username: "usuario123",
  //       message_text: "Hola, ¿cómo estás?",
  //       created_at: "2025-12-15T10:30:00.000Z"
  //     },
  //     // ... más mensajes
  //   ]
  // }
  // Nota: Los mensajes están ordenados del más antiguo al más reciente
})
```

### 4. `new_message`
Nuevo mensaje recibido en tiempo real (enviado por cualquier participante de la conversación).

```javascript
socket.on('new_message', (message) => {
  console.log('Nuevo mensaje recibido:', message)
  // message = {
  //   message_id: "uuid-del-mensaje",
  //   conversation_id: "9b7a28d8-ebae-44a7-b386-1894ba32357d",
  //   sender_id: "64582498-9091-7029-1d34-45797ea85e5b",
  //   sender_type: "influencer" | "operations",
  //   sender_username: "usuario123",
  //   message_text: "Este es un nuevo mensaje",
  //   created_at: "2025-12-15T10:35:00.000Z"
  // }
  
  // Actualizar tu UI con el nuevo mensaje
  addMessageToUI(message)
})
```

### 5. `user_joined`
Notificación cuando otro usuario se une a la conversación.

```javascript
socket.on('user_joined', (data) => {
  console.log('Usuario se unió:', data)
  // data = {
  //   user: {
  //     id: "64582498-9091-7029-1d34-45797ea85e5b",
  //     username: "usuario123",
  //     role: "influencer" | "operations"
  //   },
  //   enrollment_id: "9b7a28d8-ebae-44a7-b386-1894ba32357d"
  // }
})
```

### 6. `left_conversation`
Confirmación de que saliste de una conversación.

```javascript
socket.on('left_conversation', (data) => {
  console.log('Saliste de la conversación:', data)
  // data = {
  //   enrollment_id: "9b7a28d8-ebae-44a7-b386-1894ba32357d"
  // }
})
```

### 7. `error`
Error en cualquier operación.

```javascript
socket.on('error', (error) => {
  console.error('Error del servidor:', error)
  // error = {
  //   message: "Descripción del error"
  // }
  
  // Ejemplos de errores:
  // - "enrollment_id is required"
  // - "Access denied: You do not have access to this enrollment"
  // - "You must join the conversation first"
  // - "Error sending message"
})
```

## Eventos del Cliente → Servidor (Enviar)

### 1. `join_conversation`
Unirse a una conversación basada en `enrollment_id`.

```javascript
socket.emit('join_conversation', {
  enrollment_id: "9b7a28d8-ebae-44a7-b386-1894ba32357d"
})

// Después de emitir, recibirás:
// - 'joined_conversation' (confirmación)
// - 'conversation_history' (historial de mensajes)
```

**Restricciones**:
- Los **influencers** solo pueden unirse a enrollments donde `id_influencer` coincide con su `custom:id_influencer_main` del token Cognito.
- Los **operadores** pueden unirse a cualquier conversación.

### 2. `leave_conversation`
Salir de una conversación.

```javascript
socket.emit('leave_conversation', {
  enrollment_id: "9b7a28d8-ebae-44a7-b386-1894ba32357d"
})

// Recibirás 'left_conversation' como confirmación
```

### 3. `send_message`
Enviar un mensaje a la conversación.

```javascript
socket.emit('send_message', {
  enrollment_id: "9b7a28d8-ebae-44a7-b386-1894ba32357d",
  message_text: "Hola, este es mi mensaje"
})

// El mensaje se guarda automáticamente en DynamoDB
// Todos los participantes de la conversación recibirán 'new_message'
```

**Requisitos**:
- Debes haberte unido a la conversación primero (`join_conversation`)
- `enrollment_id` y `message_text` son requeridos

## Ejemplo Completo de Implementación

```javascript
import { io } from 'socket.io-client'

class ChatSocketService {
  constructor() {
    this.socket = null
    this.currentEnrollmentId = null
  }

  // Conectar al servidor
  connect(token) {
    this.socket = io('ws://localhost:3000', {
      auth: {
        token: token
      }
    })

    this.setupEventListeners()
    return this.socket
  }

  // Configurar listeners de eventos
  setupEventListeners() {
    // Autenticación exitosa
    this.socket.on('authenticated', (data) => {
      console.log('✅ Autenticado:', data.user)
      // Aquí puedes actualizar el estado de tu aplicación
    })

    // Historial de conversación
    this.socket.on('conversation_history', (data) => {
      console.log(`📜 Historial de ${data.enrollment_id}:`, data.messages)
      // Mostrar mensajes en la UI
      this.displayMessages(data.messages)
    })

    // Nuevo mensaje
    this.socket.on('new_message', (message) => {
      console.log('💬 Nuevo mensaje:', message)
      // Agregar mensaje a la UI en tiempo real
      this.addMessage(message)
    })

    // Usuario se unió
    this.socket.on('user_joined', (data) => {
      console.log(`👋 ${data.user.username} se unió`)
      // Mostrar notificación en la UI
    })

    // Errores
    this.socket.on('error', (error) => {
      console.error('❌ Error:', error.message)
      // Mostrar error al usuario
      alert(error.message)
    })
  }

  // Unirse a una conversación
  joinConversation(enrollmentId) {
    if (!this.socket || !this.socket.connected) {
      console.error('Socket no conectado')
      return
    }

    this.currentEnrollmentId = enrollmentId
    this.socket.emit('join_conversation', {
      enrollment_id: enrollmentId
    })
  }

  // Salir de una conversación
  leaveConversation(enrollmentId) {
    if (!this.socket) return

    this.socket.emit('leave_conversation', {
      enrollment_id: enrollmentId
    })
    this.currentEnrollmentId = null
  }

  // Enviar un mensaje
  sendMessage(messageText) {
    if (!this.socket || !this.currentEnrollmentId) {
      console.error('No hay conversación activa')
      return
    }

    this.socket.emit('send_message', {
      enrollment_id: this.currentEnrollmentId,
      message_text: messageText
    })
  }

  // Desconectar
  disconnect() {
    if (this.socket) {
      this.socket.disconnect()
      this.socket = null
    }
  }

  // Métodos auxiliares para UI (implementar según tu framework)
  displayMessages(messages) {
    // Implementar según tu framework (React, Vue, Angular, etc.)
  }

  addMessage(message) {
    // Implementar según tu framework
  }
}

// Uso:
const chatService = new ChatSocketService()

// Obtener token de Cognito
const token = localStorage.getItem('idToken') // o como manejes el token

// Conectar
chatService.connect(token)

// Cuando el usuario selecciona un enrollment para chatear
chatService.joinConversation('9b7a28d8-ebae-44a7-b386-1894ba32357d')

// Cuando el usuario envía un mensaje
chatService.sendMessage('Hola, ¿cómo estás?')

// Cuando el usuario cierra el chat
chatService.leaveConversation('9b7a28d8-ebae-44a7-b386-1894ba32357d')
```

## Ejemplo con React Hooks

```javascript
import { useEffect, useState, useRef } from 'react'
import { io } from 'socket.io-client'

function useChat(enrollmentId, token) {
  const [messages, setMessages] = useState([])
  const [isConnected, setIsConnected] = useState(false)
  const socketRef = useRef(null)

  useEffect(() => {
    // Conectar
    socketRef.current = io('ws://localhost:3000', {
      auth: { token }
    })

    socketRef.current.on('authenticated', () => {
      setIsConnected(true)
    })

    socketRef.current.on('conversation_history', (data) => {
      setMessages(data.messages || [])
    })

    socketRef.current.on('new_message', (message) => {
      setMessages(prev => [...prev, message])
    })

    socketRef.current.on('error', (error) => {
      console.error('Error:', error.message)
    })

    // Unirse a la conversación
    if (enrollmentId) {
      socketRef.current.emit('join_conversation', { enrollment_id: enrollmentId })
    }

    // Cleanup
    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect()
      }
    }
  }, [enrollmentId, token])

  const sendMessage = (messageText) => {
    if (socketRef.current && enrollmentId) {
      socketRef.current.emit('send_message', {
        enrollment_id: enrollmentId,
        message_text: messageText
      })
    }
  }

  return { messages, sendMessage, isConnected }
}

// Uso en componente
function ChatComponent({ enrollmentId }) {
  const token = localStorage.getItem('idToken')
  const { messages, sendMessage, isConnected } = useChat(enrollmentId, token)
  const [inputText, setInputText] = useState('')

  const handleSend = () => {
    if (inputText.trim()) {
      sendMessage(inputText)
      setInputText('')
    }
  }

  return (
    <div>
      <div>
        {messages.map(msg => (
          <div key={msg.message_id}>
            <strong>{msg.sender_username}</strong>: {msg.message_text}
          </div>
        ))}
      </div>
      <input 
        value={inputText}
        onChange={(e) => setInputText(e.target.value)}
        onKeyPress={(e) => e.key === 'Enter' && handleSend()}
      />
      <button onClick={handleSend}>Enviar</button>
    </div>
  )
}
```

## Notas Importantes

1. **Token JWT**: El token debe ser válido y no expirado. Si expira, deberás reconectar con un nuevo token.

2. **Múltiples Conversaciones**: Un usuario puede estar en múltiples conversaciones simultáneamente. Cada conversación es un "room" separado identificado por `enrollment_id`.

3. **Persistencia**: Todos los mensajes se guardan automáticamente en DynamoDB, así que el historial está siempre disponible.

4. **Roles**:
   - **Influencer**: Solo puede acceder a enrollments donde `id_influencer` coincide con su `custom:id_influencer_main`
   - **Operations**: Puede acceder a cualquier conversación

5. **Reconexión**: Socket.IO maneja la reconexión automática, pero deberás reenviar `join_conversation` después de una reconexión si quieres mantener la sesión activa.

6. **URL del Servidor**: Cambia `ws://localhost:3000` por la URL de tu servidor en producción.

## Instalación del Cliente

```bash
npm install socket.io-client
# o
yarn add socket.io-client
```


