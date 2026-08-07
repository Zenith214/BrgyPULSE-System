"use client"

import * as React from "react"
import { CheckCircle, XCircle, AlertCircle, X } from "lucide-react"

export interface ToastProps {
  id?: string
  title?: string
  description?: string
  type?: "success" | "error" | "warning" | "info"
  variant?: "default" | "destructive"
  duration?: number
}

interface ToastContextType {
  toasts: ToastProps[]
  addToast: (toast: Omit<ToastProps, "id">) => void
  toast: (toast: Omit<ToastProps, "id">) => void
  removeToast: (id: string) => void
}

const ToastContext = React.createContext<ToastContextType | undefined>(undefined)

export function useToast() {
  const context = React.useContext(ToastContext)
  if (!context) {
    // During SSR/build, return no-op functions instead of throwing
    if (typeof window === 'undefined') {
      return {
        toasts: [],
        addToast: () => {},
        toast: () => {},
        removeToast: () => {},
      }
    }
    throw new Error("useToast must be used within a ToastProvider")
  }
  return context
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  // Always call hooks at top level - Rules of Hooks
  const [toasts, setToasts] = React.useState<ToastProps[]>([])

  const removeToast = React.useCallback((id: string) => {
    setToasts(prev => prev.filter(toast => toast.id !== id))
  }, [])

  const addToast = React.useCallback((toast: Omit<ToastProps, "id">) => {
    const id = Math.random().toString(36).substr(2, 9)
    const newToast = { ...toast, id }
    
    setToasts(prev => [...prev, newToast])
    
    // Auto remove after duration
    if (toast.duration !== 0) {
      setTimeout(() => {
        removeToast(id)
      }, toast.duration || 5000)
    }
  }, [removeToast])

  const contextValue = React.useMemo(() => ({
    toasts,
    addToast,
    toast: addToast, // Alias for compatibility
    removeToast
  }), [toasts, addToast, removeToast])

  return (
    <ToastContext.Provider value={contextValue}>
      {children}
      <ToastContainer toasts={toasts} onRemove={removeToast} />
    </ToastContext.Provider>
  )
}

function ToastContainer({ 
  toasts, 
  onRemove 
}: { 
  toasts: ToastProps[]
  onRemove: (id: string) => void 
}) {
  if (toasts.length === 0) return null

  return (
    <div className="fixed top-4 right-4 z-50 space-y-2">
      {toasts.map((toast) => (
        <Toast key={toast.id} {...toast} onClose={() => onRemove(toast.id!)} />
      ))}
    </div>
  )
}

function Toast({ 
  title, 
  description, 
  type = "info", 
  variant,
  onClose 
}: ToastProps & { onClose?: () => void }) {
  const toastType = variant === "destructive" ? "error" : type

  const getIcon = () => {
    switch (toastType) {
      case "success":
        return <CheckCircle className="w-5 h-5 text-green-500" />
      case "error":
        return <XCircle className="w-5 h-5 text-red-500" />
      case "warning":
        return <AlertCircle className="w-5 h-5 text-yellow-500" />
      default:
        return <AlertCircle className="w-5 h-5 text-blue-500" />
    }
  }

  const getBgColor = () => {
    switch (toastType) {
      case "success":
        return "bg-green-50 border-green-200"
      case "error":
        return "bg-red-50 border-red-200"
      case "warning":
        return "bg-yellow-50 border-yellow-200"
      default:
        return "bg-blue-50 border-blue-200"
    }
  }

  return (
    <div className={`flex items-start gap-3 p-4 rounded-lg border shadow-lg min-w-80 max-w-md ${getBgColor()}`}>
      {getIcon()}
      <div className="flex-1">
        {title && <div className="font-semibold text-gray-900">{title}</div>}
        {description && <div className="text-sm text-gray-700 mt-1">{description}</div>}
      </div>
      {onClose && (
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-gray-600 transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  )
}

export type { ToastContextType }

// Compatibility exports
export const toast = () => {
  // This is a fallback - the actual toast function comes from the context
  console.warn("Toast function called outside of ToastProvider context")
}