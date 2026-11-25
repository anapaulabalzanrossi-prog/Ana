// ===================================================================
// CONFIGURAÇÃO — preencha uma única vez seguindo o GUIA.md
// Enquanto estiver vazio, o app funciona normalmente, mas guarda os
// dados só neste aparelho (sem sincronizar e sem Google Agenda).
// ===================================================================

// 1) Firebase (login com Google + sincronização entre iPhone, iPad e Mac)
//    Cole aqui o objeto "firebaseConfig" que o Firebase mostra ao criar o app Web.
export const FIREBASE_CONFIG = null;
/* Exemplo:
export const FIREBASE_CONFIG = {
  apiKey: "AIza...",
  authDomain: "minha-agenda-xxxx.firebaseapp.com",
  projectId: "minha-agenda-xxxx",
  storageBucket: "minha-agenda-xxxx.appspot.com",
  messagingSenderId: "1234567890",
  appId: "1:1234567890:web:abcdef"
};
*/

// 2) Google Agenda (ver compromissos e receber notificações no celular)
//    ID do cliente OAuth do tipo "Aplicativo da Web" (termina em .apps.googleusercontent.com)
export const GOOGLE_CLIENT_ID = "";
