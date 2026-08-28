import { google } from 'googleapis';
import { getGmailAccount, updateGmailTokens } from '../db.js';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
];

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

let refreshPromise = null;

export function getOAuth2Client(redirectUri) {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('Google OAuth credentials not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env');
  }
  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, redirectUri || undefined);
}

export function getAuthUrl(redirectUri) {
  const oauth2Client = getOAuth2Client(redirectUri);
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });
}

export async function handleCallback(code, redirectUri) {
  const oauth2Client = getOAuth2Client(redirectUri);
  const { tokens } = await oauth2Client.getToken(code);

  oauth2Client.setCredentials(tokens);
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  const profile = await gmail.users.getProfile({ userId: 'me' });

  updateGmailTokens({
    email: profile.data.emailAddress,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || '',
    expiryDate: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
  });

  return profile.data.emailAddress;
}

export async function getGmailClient() {
  const account = getGmailAccount();
  if (!account || !account.is_active) {
    throw new Error('No Gmail account connected');
  }

  const oauth2Client = getOAuth2Client();

  oauth2Client.setCredentials({
    access_token: account.access_token,
    refresh_token: account.refresh_token,
  });

  oauth2Client.on('tokens', (tokens) => {
    if (tokens.access_token || tokens.refresh_token) {
      const current = getGmailAccount();
      updateGmailTokens({
        email: current?.gmail_email || '',
        accessToken: tokens.access_token || current?.access_token,
        refreshToken: tokens.refresh_token || current?.refresh_token,
        expiryDate: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
      });
    }
  });

  if (account.token_expiry && new Date(account.token_expiry) < new Date()) {
    if (!refreshPromise) {
      refreshPromise = (async () => {
        const { credentials } = await oauth2Client.refreshAccessToken();
        updateGmailTokens({
          email: account.gmail_email,
          accessToken: credentials.access_token,
          refreshToken: credentials.refresh_token || account.refresh_token,
          expiryDate: credentials.expiry_date ? new Date(credentials.expiry_date).toISOString() : null,
        });
        oauth2Client.setCredentials(credentials);
      })().finally(() => { refreshPromise = null; });
    }
    await refreshPromise;
  }

  return google.gmail({ version: 'v1', auth: oauth2Client });
}

export async function fetchUnreadEmails() {
  const gmail = await getGmailClient();
  const response = await gmail.users.messages.list({
    userId: 'me',
    q: 'is:unread',
    maxResults: 60,
  });

  const messageIds = response.data.messages || [];
  const emails = [];

  for (const msg of messageIds) {
    const full = await gmail.users.messages.get({
      userId: 'me',
      id: msg.id,
      format: 'full',
    });
    emails.push(full.data);
  }

  return { messages: emails, truncated: false };
}

export async function markAsRead(messageId) {
  const gmail = await getGmailClient();
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: {
      removeLabelIds: ['UNREAD'],
    },
  });
}

export async function sendReply(originalMessageId, replyBody) {
  const gmail = await getGmailClient();

  const original = await gmail.users.messages.get({
    userId: 'me',
    id: originalMessageId,
    format: 'metadata',
    metadataHeaders: ['From', 'Subject', 'Message-ID', 'References', 'In-Reply-To'],
  });

  const headers = original.data.payload.headers;
  const subject = headers.find(h => h.name === 'Subject')?.value || '';
  const msgId = headers.find(h => h.name === 'Message-ID')?.value || '';
  const references = headers.find(h => h.name === 'References')?.value || '';
  const inReplyTo = headers.find(h => h.name === 'In-Reply-To')?.value || '';

  const replySubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`;

  const replyText = [
    `From: me`,
    `To: ${headers.find(h => h.name === 'From')?.value || ''}`,
    `Subject: ${replySubject}`,
    `In-Reply-To: ${msgId}`,
    `References: ${references ? references + ' ' : ''}${msgId}`,
    '',
    replyBody,
  ].join('\n');

  const encoded = Buffer.from(replyText).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw: encoded,
      threadId: original.data.threadId,
    },
  });
}
