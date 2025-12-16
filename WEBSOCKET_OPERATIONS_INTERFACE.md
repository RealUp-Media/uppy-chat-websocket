# Guía de Interfaz WebSocket para Operaciones

## Descripción General

Esta guía explica cómo implementar la interfaz de chat para **personas de operaciones** que necesitan comunicarse con influencers sobre enrollments específicos.

## Diferencias Clave entre Operaciones e Influencers

| Aspecto | Operaciones | Influencers |
|---------|-------------|-------------|
| **Acceso** | Pueden acceder a CUALQUIER conversación | Solo sus propios enrollments |
| **Rol** | `operations` | `influencer` |
| **Selección de conversación** | Pueden elegir cualquier `enrollment_id` | Solo ven enrollments donde `id_influencer` coincide con su `custom:id_influencer_main` |

## Autenticación

El usuario de operaciones debe autenticarse con un token JWT de AWS Cognito que pertenezca al grupo `operations`.

```javascript
import { io } from 'socket.io-client'

const token = 'jwt-token-de-cognito-del-usuario-operations'

const socket = io('ws://localhost:3000', {
  auth: {
    token: token
  }
})
```

## Flujo Completo de la Interfaz de Operaciones

### 1. **Lista de Conversaciones Disponibles**

**IMPORTANTE**: El backend NO proporciona un endpoint para listar conversaciones. El frontend debe:

- Tener acceso a la lista de enrollments desde otra API/endpoint
- Filtrar enrollments según tus reglas de negocio (status, fecha, etc.)
- Mostrar la lista de enrollments disponibles para chat

**Estructura sugerida para mostrar:**
```
┌─────────────────────────────────────┐
│ 📋 Conversaciones Activas           │
├─────────────────────────────────────┤
│ 🟢 Enrollment: abc-123-456          │
│    Influencer: Realup Media         │
│    Campaign: Summer Campaign        │
│    Último mensaje: Hace 2 horas     │
├─────────────────────────────────────┤
│ 🟢 Enrollment: def-789-012          │
│    Influencer: Another Influencer   │
│    Campaign: Winter Campaign        │
│    Último mensaje: Hace 1 día       │
└─────────────────────────────────────┘
```

### 2. **Conexión y Autenticación**

```javascript
socket.on('authenticated', (data) => {
  console.log('✅ Autenticado como operaciones:', data.user)
  // data.user = {
  //   id: "user-sub-de-cognito",
  //   email: "operations@example.com",
  //   role: "operations",
  //   username: "operations_user"
  // }
  
  // Guardar información del usuario
  currentUser = data.user
  
  // Cargar lista de conversaciones disponibles
  loadConversations()
})
```

### 3. **Unirse a una Conversación**

Cuando el usuario de operaciones selecciona un enrollment para chatear:

```javascript
// El usuario hace clic en un enrollment de la lista
function openChat(enrollmentId) {
  // Unirse a la conversación
  socket.emit('join_conversation', {
    enrollment_id: enrollmentId
  })
  
  currentEnrollmentId = enrollmentId
}

// Escuchar confirmación
socket.on('joined_conversation', (data) => {
  console.log('Te uniste a:', data.enrollment_id)
  // data = { enrollment_id: "9b7a28d8-ebae-44a7-b386-1894ba32357d" }
  
  // Mostrar el chat UI
  showChatInterface(data.enrollment_id)
})
```

### 4. **Cargar Historial de Mensajes**

El historial se recibe automáticamente al unirte:

```javascript
socket.on('conversation_history', (data) => {
  console.log('Historial recibido:', data)
  // data = {
  //   enrollment_id: "9b7a28d8-ebae-44a7-b386-1894ba32357d",
  //   messages: [
  //     {
  //       message_id: "msg-uuid-1",
  //       conversation_id: "enrollment-id",
  //       sender_id: "user-sub",
  //       sender_type: "influencer",  // o "operations"
  //       sender_username: "realup.media",
  //       message_text: "Hola, tengo una pregunta",
  //       created_at: "2025-12-15T10:30:00.000Z"
  //     },
  //     // ... más mensajes ordenados del más antiguo al más reciente
  //   ]
  // }
  
  // Mostrar mensajes en la UI
  displayMessages(data.messages)
})
```

### 5. **Interfaz de Chat Sugerida**

```
┌─────────────────────────────────────────────────────────┐
│ ← Volver    Enrollment: abc-123-456    Influencer: ...  │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  [Influencer] 10:30 AM                                  │
│  Hola, tengo una pregunta sobre el brief                │
│                                                          │
│  [Operations] 10:32 AM                                  │
│  Claro, ¿en qué puedo ayudarte?                         │
│                                                          │
│  [Influencer] 10:33 AM                                  │
│  Necesito más información sobre los requisitos          │
│                                                          │
│                                                          │
├─────────────────────────────────────────────────────────┤
│  [Escribe un mensaje...]           [📎] [Enviar]        │
└─────────────────────────────────────────────────────────┘
```

### 6. **Enviar Mensajes**

```javascript
function sendMessage(messageText) {
  if (!currentEnrollmentId) {
    alert('Debes seleccionar una conversación primero')
    return
  }
  
  socket.emit('send_message', {
    enrollment_id: currentEnrollmentId,
    message_text: messageText
  })
  
  // El mensaje se agregará a la UI cuando recibas 'new_message'
  // Opcionalmente puedes agregarlo inmediatamente con estado "enviando"
  addMessageToUI({
    message_text: messageText,
    sender_type: 'operations',
    sender_username: currentUser.username,
    created_at: new Date().toISOString(),
    sending: true // estado temporal
  })
}

// Ejemplo de uso desde un input
messageInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    const message = messageInput.value.trim()
    if (message) {
      sendMessage(message)
      messageInput.value = ''
    }
  }
})
```

### 7. **Recibir Mensajes en Tiempo Real**

```javascript
socket.on('new_message', (message) => {
  console.log('Nuevo mensaje recibido:', message)
  // message = {
  //   message_id: "msg-uuid",
  //   conversation_id: "enrollment-id",
  //   sender_id: "user-sub",
  //   sender_type: "influencer" | "operations",
  //   sender_username: "usuario",
  //   message_text: "Texto del mensaje",
  //   created_at: "2025-12-15T10:35:00.000Z"
  // }
  
  // Agregar mensaje a la UI solo si es de la conversación actual
  if (message.conversation_id === currentEnrollmentId) {
    addMessageToUI(message)
    
    // Scroll automático al último mensaje
    scrollToBottom()
    
    // Notificación si la ventana no está enfocada
    if (!document.hasFocus()) {
      showNotification('Nuevo mensaje de ' + message.sender_username)
    }
  } else {
    // Si es de otra conversación, actualizar indicador de mensajes no leídos
    updateUnreadCount(message.conversation_id)
  }
})
```

### 8. **Notificaciones de Usuarios**

```javascript
socket.on('user_joined', (data) => {
  console.log('Usuario se unió:', data)
  // data = {
  //   user: {
  //     id: "user-sub",
  //     username: "realup.media",
  //     role: "influencer"
  //   },
  //   enrollment_id: "enrollment-id"
  // }
  
  // Mostrar indicador de que el influencer está en línea
  if (data.enrollment_id === currentEnrollmentId) {
    showUserStatus(data.user.username, 'online')
  }
})
```

### 9. **Salir de una Conversación**

```javascript
function closeChat() {
  if (currentEnrollmentId) {
    socket.emit('leave_conversation', {
      enrollment_id: currentEnrollmentId
    })
    currentEnrollmentId = null
  }
  
  // Ocultar chat UI
  hideChatInterface()
}

socket.on('left_conversation', (data) => {
  console.log('Saliste de:', data.enrollment_id)
})
```

### 10. **Manejo de Errores**

```javascript
socket.on('error', (error) => {
  console.error('Error:', error.message)
  // error = { message: "Descripción del error" }
  
  // Ejemplos de errores:
  // - "enrollment_id is required"
  // - "You must join the conversation first"
  // - "Error loading conversation history"
  // - "Error sending message"
  
  // Mostrar notificación al usuario
  showError(error.message)
})
```

## Ejemplo Completo de Componente React

```javascript
import { useEffect, useState, useRef } from 'react'
import { io } from 'socket.io-client'

function OperationsChatInterface({ enrollmentId, token }) {
  const [messages, setMessages] = useState([])
  const [isConnected, setIsConnected] = useState(false)
  const [inputText, setInputText] = useState('')
  const socketRef = useRef(null)
  const messagesEndRef = useRef(null)

  useEffect(() => {
    // Conectar
    socketRef.current = io('ws://localhost:3000', {
      auth: { token }
    })

    socketRef.current.on('authenticated', (data) => {
      console.log('Autenticado:', data.user)
      setIsConnected(true)
      
      // Unirse a la conversación
      if (enrollmentId) {
        socketRef.current.emit('join_conversation', {
          enrollment_id: enrollmentId
        })
      }
    })

    socketRef.current.on('conversation_history', (data) => {
      setMessages(data.messages || [])
      scrollToBottom()
    })

    socketRef.current.on('new_message', (message) => {
      setMessages(prev => [...prev, message])
      scrollToBottom()
    })

    socketRef.current.on('error', (error) => {
      alert('Error: ' + error.message)
    })

    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect()
      }
    }
  }, [enrollmentId, token])

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  const sendMessage = () => {
    if (!inputText.trim() || !enrollmentId) return

    socketRef.current.emit('send_message', {
      enrollment_id: enrollmentId,
      message_text: inputText
    })
    
    setInputText('')
  }

  return (
    <div className="chat-container">
      <div className="messages">
        {messages.map(msg => (
          <div 
            key={msg.message_id} 
            className={`message ${msg.sender_type === 'operations' ? 'own' : 'other'}`}
          >
            <div className="message-header">
              <strong>{msg.sender_username}</strong>
              <span className="timestamp">
                {new Date(msg.created_at).toLocaleTimeString()}
              </span>
            </div>
            <div className="message-text">{msg.message_text}</div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>
      
      <div className="input-area">
        <input
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
          placeholder="Escribe un mensaje..."
        />
        <button onClick={sendMessage}>Enviar</button>
      </div>
    </div>
  )
}

export default OperationsChatInterface
```

## Características Adicionales Recomendadas

### 1. **Indicador de Escritura** (Opcional)
```javascript
// Mostrar cuando el influencer está escribiendo
socket.on('user_typing', (data) => {
  if (data.enrollment_id === currentEnrollmentId) {
    showTypingIndicator(data.user.username)
  }
})
```

### 2. **Mensajes No Leídos**
- Mantener contador de mensajes no leídos por conversación
- Actualizar cuando recibes `new_message` de conversaciones no activas
- Marcar como leídos cuando abres la conversación

### 3. **Búsqueda de Mensajes**
- Implementar búsqueda local en el historial cargado
- Para búsquedas más completas, hacer query a DynamoDB desde el backend

### 4. **Notificaciones Push**
- Configurar notificaciones del navegador para nuevos mensajes
- Solo cuando la ventana no está enfocada

### 5. **Estado de Conexión**
```javascript
socket.on('connect', () => {
  console.log('✅ Conectado al servidor')
  showConnectionStatus('conectado')
})

socket.on('disconnect', () => {
  console.log('❌ Desconectado del servidor')
  showConnectionStatus('desconectado')
})

socket.on('connect_error', (error) => {
  console.error('Error de conexión:', error)
  showConnectionStatus('error')
})
```

## Resumen de Eventos

### Enviar al Servidor:
- `join_conversation` - `{ enrollment_id: string }`
- `leave_conversation` - `{ enrollment_id: string }`
- `send_message` - `{ enrollment_id: string, message_text: string }`

### Recibir del Servidor:
- `authenticated` - Confirmación de autenticación
- `joined_conversation` - `{ enrollment_id: string }`
- `conversation_history` - `{ enrollment_id: string, messages: Message[] }`
- `new_message` - `Message`
- `user_joined` - `{ user: User, enrollment_id: string }`
- `left_conversation` - `{ enrollment_id: string }`
- `error` - `{ message: string }`

## Tips Importantes

1. **Múltiples Conversaciones**: Un usuario de operaciones puede estar en múltiples conversaciones simultáneamente. Cada una es un "room" separado.

2. **Lista de Enrollments**: El backend NO proporciona la lista de enrollments. Debes obtenerla de tu API existente.

3. **Permisos**: Los usuarios de operaciones pueden acceder a CUALQUIER enrollment sin restricciones.

4. **Persistencia**: Todos los mensajes se guardan automáticamente en DynamoDB. El historial siempre estará disponible.

5. **Reconexión**: Socket.IO maneja reconexión automática. Debes reenviar `join_conversation` después de una reconexión si quieres mantener la sesión activa.


