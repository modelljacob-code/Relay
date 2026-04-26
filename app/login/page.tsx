// Auth is currently disabled — users play as guests with anonymous sessions.
// LoginClient.tsx is preserved and can be re-enabled here when needed.
import { redirect } from "next/navigation";

export default function LoginPage() {
  redirect("/");
}
