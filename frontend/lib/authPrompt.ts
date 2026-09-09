// Guest-mode sign-in prompt bus.
//
// The app no longer walls itself behind /login (2026-09-03 per operator):
// anonymous visitors can open every browse surface, and only FEATURE use
// (uploading documents, sending a chat message — anything that writes) asks
// for an account. Feature entry points call promptSignIn(); the globally
// mounted <SignInPromptDialog /> (App.tsx) listens and offers Sign in /
// Create account. A plain module rather than React context so non-component
// code (lib/supabase's uploadDocument) can trigger it too.

type Listener = () => void;
const listeners = new Set<Listener>();

/** Ask the visitor to sign in. No-op when nothing is mounted to listen. */
export function promptSignIn(): void {
  listeners.forEach((l) => l());
}

/** Subscribe to prompt requests. Returns the unsubscribe function. */
export function onSignInPrompt(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
