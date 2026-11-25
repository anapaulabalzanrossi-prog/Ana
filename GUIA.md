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

## Passo 3. Google Agenda e notificações

1. Acesse https://console.cloud.google.com e, no seletor de projetos no topo, escolha o mesmo projeto criado no Firebase.
2. Busque por **Google Calendar API** e clique em **Ativar**.
3. Abra **APIs e serviços → Tela de permissão OAuth** (ou "Google Auth Platform"):
   - Tipo de usuário: **Externo**. Nome do app: `Minha Agenda`. Informe seu e-mail nos campos de suporte e contato.
   - Em **Público-alvo / Usuários de teste**, adicione o seu próprio e-mail do Google.
   - Pode deixar o app em modo **Teste**: ele é só para você.
4. Abra **APIs e serviços → Credenciais**. Na lista "IDs do cliente OAuth 2.0", clique em **Web client (auto created by Google Service)**.
5. Em **Origens JavaScript autorizadas**, adicione `https://anapaulabalzanrossi-prog.github.io` e salve.
6. **Copie o "ID do cliente"** (termina em `.apps.googleusercontent.com`).

Ao conectar pela primeira vez, o Google vai avisar que "o app não foi verificado". Isso é esperado, porque o app é seu e está em modo de teste. Clique em **Continuar**.

## Passo 4. Enviar as chaves

Mande para o Claude, nesta conversa, o bloco `firebaseConfig` (passo 2.3) e o ID do cliente (passo 3.6). O Claude coloca no arquivo `js/config.js` e publica. Esses dados não são senhas: eles identificam o app, e a proteção vem das regras do passo 2.7 e do seu login.

Se preferir fazer sozinha: no GitHub, abra `js/config.js` na branch acima, clique no lápis, preencha `FIREBASE_CONFIG` e `GOOGLE_CLIENT_ID` e clique em **Commit changes**.

## Passo 5. Instalar no iPad, no iPhone e no Mac

- **iPad e iPhone:** abra o endereço no **Safari**, toque em **Compartilhar** (quadrado com seta) e depois em **Adicionar à Tela de Início**. O app abre em tela cheia, como um app comum.
- **Mac:** no Safari, use o menu **Arquivo → Adicionar ao Dock**.
- Abra o app, toque em **Ajustes → Entrar com Google** e depois em **Conectar** a Google Agenda. Repita em cada aparelho com a mesma conta.

## Como funcionam as notificações

Quando uma tarefa tem data e lembretes, o app cria um evento correspondente na sua Google Agenda, com alertas (por exemplo, 3 dias antes, 1 dia antes e no dia). Quem dispara a notificação é a Google Agenda, então ela chega mesmo com o app fechado. Para isso:

- Tenha o app **Google Agenda** instalado no iPhone/iPad com as notificações permitidas, **ou** a conta Google adicionada ao Calendário da Apple (Ajustes → Calendário → Contas).
- Prazos fatais recebem automaticamente alertas 3 dias antes, 1 dia antes e no dia.
- Os padrões podem ser mudados em **Ajustes** no app.

## Limitações desta primeira versão

- Por regra do Google, a conexão com a Google Agenda dura cerca de 1 hora de cada vez. Quando expira, o app mostra um aviso "Reconectar" (um toque). As notificações não são afetadas, porque já ficam gravadas na Google Agenda. As tarefas criadas enquanto a agenda está desconectada ficam marcadas e são enviadas na próxima conexão.
- A escrita à mão fica salva como imagem e traços. Ainda não há reconhecimento de texto manuscrito.
- Faça um backup de vez em quando em **Ajustes → Exportar**.
