import { notFound } from 'next/navigation';

/**
 * The in-app Assistant is switched off for now. Its page code stays in
 * place, but the route always 404s. Connected AI apps over MCP (Settings →
 * Connected apps) are the supported AI path. To bring it back, delete this
 * file and restore the nav link in components/keel/app-shell.tsx.
 */
export default function AssistantLayout(): never {
  notFound();
}
