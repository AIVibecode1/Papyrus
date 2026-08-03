import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

function Fallback({ message }: { message: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10">
        <AlertTriangle className="size-6 text-destructive" />
      </div>
      <h1 className="text-lg font-semibold">{t("errors.title")}</h1>
      <p className="max-w-md text-sm text-muted-foreground">{message}</p>
      <Button onClick={() => window.location.reload()}>{t("errors.reload")}</Button>
    </div>
  );
}

/**
 * Last line of defense against white screens: any render error inside the
 * app is caught here and replaced with a friendly recovery screen.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Papyrus render error:", error, info);
  }

  render() {
    if (this.state.error) {
      return <Fallback message={this.state.error.message} />;
    }
    return this.props.children;
  }
}
