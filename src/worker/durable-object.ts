import { Env, SSHConnectionConfig } from '../types';
import { SSHSession } from './ssh-session';

export class SSHSessionDO {
  private state: DurableObjectState;
  private env: Env;
  private sessions: Map<WebSocket, SSHSession> = new Map();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    console.log('DO fetch called:', request.url);
    return this.handleWebSocketUpgrade(request);
  }

  private async handleWebSocketUpgrade(request: Request): Promise<Response> {
    const sshConfig = this.extractSSHConfig(request);
    if (!sshConfig) {
      return new Response('Missing SSH config', { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    (server as any).accept();

    await this.initSSHSession(server, sshConfig);

    return new Response(null, {
      status: 101,
      webSocket: client,
    } as any);
  }

  private extractSSHConfig(request: Request): SSHConnectionConfig | null {
    const url = new URL(request.url);
    const host = url.searchParams.get('host');
    const port = parseInt(url.searchParams.get('port') || '22');
    const username = url.searchParams.get('user');
    const password = url.searchParams.get('pass');

    if (!host || !username || !password) return null;

    const hostRegex = /^[\w\.\-]+$/;
    if (!hostRegex.test(host)) return null;

    if (isNaN(port) || port < 1 || port > 65535) return null;

    const userRegex = /^[\w\.\-@]+$/;
    if (!userRegex.test(username)) return null;

    return { host, port, username, password };
  }

  private async initSSHSession(
    ws: WebSocket,
    config: SSHConnectionConfig
  ): Promise<void> {
    try {
      // Cloudflare Workers TCP 连接
      const { connect } = await import('cloudflare:sockets');
      const socket = connect({ hostname: config.host, port: config.port });
      
      // 等待连接建立
      const opened = await socket.opened;
      console.log('TCP connected to', config.host, config.port);

      const session = new SSHSession(ws, socket, config);
      this.sessions.set(ws, session);

      ws.addEventListener('message', (event) => {
        session.handleWebSocketMessage(event.data);
      });

      ws.addEventListener('close', () => {
        session.close();
        this.sessions.delete(ws);
      });

      ws.addEventListener('error', () => {
        session.close();
        this.sessions.delete(ws);
      });

      await session.startHandshake();

    } catch (error) {
      console.error('SSH session error:', error);
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      const errStack = error instanceof Error ? error.stack : '';
      console.error('Error stack:', errStack);
      ws.send(JSON.stringify({ type: 'error', message: `连接失败: ${errMsg}` }));
      ws.close(1011, 'SSH connection failed');
    }
  }
}
