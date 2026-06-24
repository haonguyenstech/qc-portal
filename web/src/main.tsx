import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import './index.css'
import App from './App.tsx'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ProjectProvider } from '@/lib/project-context'
import { NotificationProvider } from '@/lib/notifications'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ProjectProvider>
        <NotificationProvider>
          <BrowserRouter>
            <TooltipProvider delayDuration={200}>
              <App />
            </TooltipProvider>
            <Toaster />
          </BrowserRouter>
        </NotificationProvider>
      </ProjectProvider>
    </QueryClientProvider>
  </StrictMode>,
)
