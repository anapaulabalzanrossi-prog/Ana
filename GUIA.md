# Minha Agenda: guia de configuração

O app já funciona assim que for publicado, guardando os dados no próprio aparelho. Os passos 2 e 3 ativam a sincronização entre iPhone, iPad e Mac e a integração com a Google Agenda (que é o que gera as notificações). Cada passo é feito uma única vez.

## Passo 1. Publicar o app (GitHub Pages, gratuito)

1. Abra https://github.com/anapaulabalzanrossi-prog/Ana/settings/pages
2. Em **Source**, escolha **Deploy from a branch**.
3. Em **Branch**, escolha `claude/personal-agenda-app-c9oicq` e a pasta `/ (root)`. Clique em **Save**.
4. Em um ou dois minutos o app estará em: **https://anapaulabalzanrossi-prog.github.io/Ana/**

O código é público, mas seus dados não ficam no código: ficam no aparelho ou, depois do passo 2, na sua conta do Firebase, protegidos pelo seu login.

## Passo 2. Sincronização (Firebase, gratuito)

1. Acesse https://console.firebase.google.com com sua conta Google e clique em **Criar projeto**. Nome sugerido: `minha-agenda`. Pode desativar o Google Analytics.
2. Na tela inicial do projeto, clique no ícone **Web** (`</>`), dê o apelido `agenda` e clique em **Registrar app**. Não precisa marcar Hosting.
3. O Firebase mostrará um bloco `const firebaseConfig = { ... }`. **Copie esse bloco.**
4. No menu lateral, abra **Authentication → Começar → Google**, ative e salve.
5. Ainda em Authentication, vá em **Configurações → Domínios autorizados → Adicionar domínio** e inclua `anapaulabalzanrossi-prog.github.io`.
6. No menu lateral, abra **Firestore Database → Criar banco de dados**, escolha o local `southamerica-east1 (São Paulo)` e o **modo de produção**.
7. Na aba **Regras** do Firestore, apague o conteúdo, cole o texto abaixo e clique em **Publicar**:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}
```

Essas regras garantem que só você, logada, lê e grava os seus dados.

## Passo 3. Google Agenda e notificações (uma única vez)

No app, abra **Ajustes → Google Agenda → Ligar** e siga as 5 etapas da tela. Você copia um pequeno código (o "conector"), cola no Google Apps Script da sua conta e autoriza uma vez. A configuração vale para todos os aparelhos e não expira: o app nunca mais pede para conectar.

## Passo 4. Enviar as chaves

Mande para o Claude, nesta conversa, o bloco `firebaseConfig` (passo 2.3). O Claude coloca no arquivo `js/config.js` e publica. Esses dados não são senhas: eles identificam o app, e a proteção vem das regras do passo 2.7 e do seu login.

Se preferir fazer sozinha: no GitHub, abra `js/config.js` na branch acima, clique no lápis, preencha `FIREBASE_CONFIG` e clique em **Commit changes**.

## Passo 5. Instalar no iPad, no iPhone e no Mac

- **iPad e iPhone:** abra o endereço no **Safari**, toque em **Compartilhar** (quadrado com seta) e depois em **Adicionar à Tela de Início**. O app abre em tela cheia, como um app comum.
- **Mac:** no Safari, use o menu **Arquivo → Adicionar ao Dock**.
- Abra o app e toque em **Ajustes → Entrar com Google**. Repita em cada aparelho com a mesma conta. A Google Agenda já vem ligada.

## Como funcionam as notificações

Quando uma tarefa tem data e lembretes, o app cria um evento correspondente na sua Google Agenda, com alertas (por exemplo, 3 dias antes, 1 dia antes e no dia). Quem dispara a notificação é a Google Agenda, então ela chega mesmo com o app fechado. Para isso:

- Tenha o app **Google Agenda** instalado no iPhone/iPad com as notificações permitidas, **ou** a conta Google adicionada ao Calendário da Apple (Ajustes → Calendário → Contas).
- Prazos fatais recebem automaticamente alertas 3 dias antes, 1 dia antes e no dia.
- Os padrões podem ser mudados em **Ajustes** no app.

## Limitações desta primeira versão

- Para editar ou excluir um compromisso que veio da Google Agenda, use o próprio app da Google Agenda.
- A escrita à mão fica salva como imagem e traços. Ainda não há reconhecimento de texto manuscrito.
- Faça um backup de vez em quando em **Ajustes → Exportar**.
