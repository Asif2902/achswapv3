import { useToast } from "@/hooks/use-toast"
import { cn } from "@/lib/utils"
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
  ToastIcon,
  CopyButton,
} from "@/components/ui/toast"

export function Toaster() {
  const { toasts } = useToast()

  return (
    <ToastProvider swipeDirection="right">
      {toasts.map(function ({ id, title, description, action, rawError, variant, duration = 5000, ...props }) {
        return (
          <Toast 
            key={id} 
            variant={variant} 
            duration={duration}
            {...props}
          >
            <div className="relative flex items-start gap-3 pr-8">
              <ToastIcon variant={variant} />
              <div className="flex-1 grid gap-1 min-w-0">
                {title && <ToastTitle>{title}</ToastTitle>}
                {description && (
                  <ToastDescription>{description}</ToastDescription>
                )}
                {rawError && (
                  <div className="mt-3 pt-3 border-t border-zinc-800">
                    <CopyButton text={rawError} />
                  </div>
                )}
              </div>
            </div>
            
            {action}
            <ToastClose />
            
            <div className="absolute bottom-0 left-0 right-0 h-1 bg-zinc-800/50 overflow-hidden rounded-b-xl">
              <div 
                className={cn(
                  "h-full animate-shrink rounded-full",
                  variant === "destructive" ? "bg-red-500" :
                  variant === "success" ? "bg-emerald-500" :
                  variant === "warning" ? "bg-amber-500" :
                  "bg-cyan-500"
                )}
                style={{ 
                  animation: `shrink ${duration}ms linear forwards`,
                }}
              />
            </div>
          </Toast>
        )
      })}
      <ToastViewport />
    </ToastProvider>
  )
}
