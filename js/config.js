// ===================================================================
// CONFIGURAÇÃO — preencha uma única vez seguindo o GUIA.md
// Enquanto estiver vazio, o app funciona normalmente, mas guarda os
// dados só neste aparelho (sem sincronizar e sem Google Agenda).
// ===================================================================

// 1) Firebase (login com Google + sincronização entre iPhone, iPad e Mac)
//    Cole aqui o objeto "firebaseConfig" que o Firebase mostra ao criar o app Web.
export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDBhMiJe06oaReNdeHZEJiRIzYMxwXRAzE",
  authDomain: "minha-agenda-329d9.firebaseapp.com",
  projectId: "minha-agenda-329d9",
  storageBucket: "minha-agenda-329d9.firebasestorage.app",
  messagingSenderId: "1016054799003",
  appId: "1:1016054799003:web:6c7ed17be7335e1c40843e"
};
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

// 2) Não é mais usado: a Google Agenda agora conecta por um conector configurado
//    dentro do app (Ajustes → Google Agenda), que não expira.
export const GOOGLE_CLIENT_ID = "1016054799003-2nkmcedek906s1m3uqartritvdggfq7c.apps.googleusercontent.com";
