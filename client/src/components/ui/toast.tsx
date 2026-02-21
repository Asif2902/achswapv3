import * as React from "react"
import * as ToastPrimitives from "@radix-ui/react-toast"
import { cva, type VariantProps } from "class-variance-authority"
import { X, Copy, Check, AlertCircle, CheckCircle2, Info, AlertTriangle } from "lucide-react"

import { cn } from "@/lib/utils"

const ToastProvider = ToastPrimitives.Provider

const ToastViewport = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Viewport>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Viewport>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Viewport
    ref={ref}
    className={cn(
      "fixed top-0 right-0 z-[100] flex max-h-screen w-full flex-col-reverse p-4 gap-3 sm:bottom-0 sm:right-0 sm:top-auto sm:flex-col md:max-w-[380px]",
      className
    )}
    {...props}
  />
))
ToastViewport.displayName = ToastPrimitives.Viewport.displayName

const toastVariants = cva(
  "group pointer-events-auto relative overflow-hidden rounded-xl border p-4 shadow-2xl transition-all duration-300",
  {
    variants: {
      variant: {
        default: "border-zinc-800 bg-zinc-950/95 text-zinc-100 backdrop-blur-xl",
        destructive: "border-red-500/50 bg-red-950/95 text-red-100 backdrop-blur-xl",
        success: "border-emerald-500/50 bg-emerald-950/95 text-emerald-100 backdrop-blur-xl",
        warning: "border-amber-500/50 bg-amber-950/95 text-amber-100 backdrop-blur-xl",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

const Toast = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Root> &
    VariantProps<typeof toastVariants>
>(({ className, variant, ...props }, ref) => {
  return (
    <ToastPrimitives.Root
      ref={ref}
      className={cn(toastVariants({ variant }), className)}
      {...props}
    />
  )
})
Toast.displayName = ToastPrimitives.Root.displayName

const ToastAction = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Action>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Action>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Action
    ref={ref}
    className={cn(
      "inline-flex h-8 shrink-0 items-center justify-center rounded-lg border border-zinc-700 bg-zinc-800/80 px-3 text-sm font-semibold text-zinc-100 transition-all hover:bg-zinc-700 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:ring-offset-2 focus:ring-offset-zinc-950 disabled:pointer-events-none disabled:opacity-50",
      className
    )}
    {...props}
  />
))
ToastAction.displayName = ToastPrimitives.Action.displayName

const ToastClose = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Close>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Close>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Close
    ref={ref}
    className={cn(
      "absolute right-3 top-3 rounded-lg p-1.5 text-zinc-500 opacity-0 transition-all hover:bg-zinc-800 hover:text-zinc-300 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-cyan-500 group-hover:opacity-100",
      className
    )}
    toast-close=""
    {...props}
  >
    <X className="h-4 w-4" />
  </ToastPrimitives.Close>
))
ToastClose.displayName = ToastPrimitives.Close.displayName

const ToastTitle = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Title>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Title>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Title
    ref={ref}
    className={cn("text-sm font-bold tracking-wide uppercase", className)}
    {...props}
  />
))
ToastTitle.displayName = ToastPrimitives.Title.displayName

const ToastDescription = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Description>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Description>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Description
    ref={ref}
    className={cn("text-sm text-zinc-400 leading-relaxed", className)}
    {...props}
  />
))
ToastDescription.displayName = ToastPrimitives.Description.displayName

const ToastIcon = ({ variant }: { variant?: string }) => {
  const iconClass = "h-5 w-5 shrink-0"
  
  switch (variant) {
    case "destructive":
      return (
        <div className="relative">
          <AlertCircle className={`${iconClass} text-red-400`} />
          <div className="absolute inset-0 blur-md bg-red-400/50" />
        </div>
      )
    case "success":
      return (
        <div className="relative">
          <CheckCircle2 className={`${iconClass} text-emerald-400`} />
          <div className="absolute inset-0 blur-md bg-emerald-400/50" />
        </div>
      )
    case "warning":
      return (
        <div className="relative">
          <AlertTriangle className={`${iconClass} text-amber-400`} />
          <div className="absolute inset-0 blur-md bg-amber-400/50" />
        </div>
      )
    default:
      return <Info className={`${iconClass} text-cyan-400`} />
  }
}

const CopyButton = ({ text }: { text?: string }) => {
  const [copied, setCopied] = React.useState(false)

  if (!text) return null

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error("Failed to copy:", err)
    }
  }

  return (
    <button
      onClick={handleCopy}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-all",
        "bg-zinc-800/80 border border-zinc-700 hover:border-cyan-500/50 hover:bg-zinc-700",
        "text-zinc-400 hover:text-cyan-400",
        "focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
      )}
      title="Copy error details for debugging"
    >
      {copied ? (
        <>
          <Check className="h-3 w-3 text-emerald-400" />
          <span className="text-emerald-400">Copied!</span>
        </>
      ) : (
        <>
          <Copy className="h-3 w-3" />
          <span>Copy error</span>
        </>
      )}
    </button>
  )
}

type ToastProps = React.ComponentPropsWithoutRef<typeof Toast>

type ToastActionElement = React.ReactElement<typeof ToastAction>

export {
  type ToastProps,
  type ToastActionElement,
  ToastProvider,
  ToastViewport,
  Toast,
  ToastTitle,
  ToastDescription,
  ToastClose,
  ToastAction,
  ToastIcon,
  CopyButton,
}
