// Memoria (D122, design round 41 memory.jsx): what the agents remember of the person.
export const memory = {
  title: 'Memoria',
  subtitle:
    'Lo que los agentes recuerdan de ti entre conversaciones. Cada agente recuerda solo lo suyo, y nadie más lo ve: ni otros agentes, ni otras personas, ni quien creó el agente, ni los administradores.',
  foot: 'Los recuerdos los saca el servicio de AWS de tus conversaciones; tú no los escribes. Solo se usan en el chat: las tareas programadas, las evals y el Playground no tienen memoria.',
  loading: 'Cargando tu memoria',
  off: {
    title: 'La memoria está apagada en esta instalación',
    body: 'Mientras esté apagada, los agentes no recuerdan nada entre conversaciones y no hay nada guardado de ti.',
  },
  empty: {
    title: 'Ningún agente recuerda nada de ti',
    body: 'Los agentes con memoria guardan preferencias, hechos y resúmenes de lo que hablas con ellos. Aparecerán aquí.',
  },
  unavailable: {
    title: 'La memoria no está disponible ahora',
    body: 'No se pudieron cargar tus recuerdos. Inténtalo de nuevo en unos minutos.',
  },
  rate: {
    title: 'Demasiadas solicitudes.',
    body: 'Puedes pedir tu memoria hasta 30 veces por minuto.',
  },
  over: 'Se muestran tus {{shown}} recuerdos más recientes de {{total}}. «Borrar todo» también borra los que no se ven.',
  agent: 'Agente',
  allAgents: 'Todos los agentes',
  kindLabel: 'Tipo',
  kinds: {
    all: 'Todos',
    preferences: 'Preferencias',
    facts: 'Hechos',
    summaries: 'Resúmenes',
  },
  kind: {
    preferences: 'Preferencia',
    facts: 'Hecho',
    summaries: 'Resumen',
  },
  count_one: '{{formatted}} recuerdo',
  count_other: '{{formatted}} recuerdos',
  countOf: '{{shown}} de {{total}}',
  deleteAll: 'Borrar todo…',
  noMatch: 'Ningún recuerdo coincide',
  noMatchHint: 'Prueba con otro agente o tipo.',
  truncated: 'Texto recortado: el recuerdo completo es más largo.',
  deleteOne: 'Borrar este recuerdo',
  deleteOneTitle: 'Borrar',
  confirmLabel: 'Confirmar borrado',
  confirmOne: '{{agent}} dejará de recordarlo. No se puede deshacer.',
  cancel: 'Cancelar',
  delete: 'Borrar',
  deleting: 'Borrando…',
  deleted: 'Recuerdo borrado.',
  allTitle: 'Borrar toda tu memoria',
  allBody_one:
    'Todos los agentes dejarán de recordar lo que saben de ti: {{formatted}} recuerdo{{hidden}}, y lo que guardaron tus tareas. No se puede deshacer.',
  allBody_other:
    'Todos los agentes dejarán de recordar lo que saben de ti: {{formatted}} recuerdos{{hidden}}, y lo que guardaron tus tareas. No se puede deshacer.',
  allHidden: ', también los que no se ven en la lista',
  allConfirm: 'Borrar todo',
  allDeleted: 'Se borraron {{records}} recuerdos y {{events}} eventos.',
} as const;
