import { createClient, SupabaseClient } from '@supabase/supabase-js'

// Supabase configuration
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

// Validate required environment variables at runtime (not build time)
function validateSupabaseConfig() {
  const isBuildTime = process.env.NEXT_PHASE === 'phase-production-build' || 
                      (typeof window === 'undefined' && !supabaseUrl);
  
  if (!supabaseUrl || !supabaseAnonKey) {
    if (isBuildTime) {
      console.warn('Supabase credentials not found during build. This is expected.')
      return false;
    } else if (typeof window !== 'undefined') {
      console.error('Missing required environment variable: NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY')
    }
  }
  return true;
}

// Create placeholder client for build time
const placeholderClient = {
  from: () => ({
    select: () => Promise.resolve({ data: null, error: new Error('Supabase not initialized') }),
    insert: () => Promise.resolve({ data: null, error: new Error('Supabase not initialized') }),
    update: () => Promise.resolve({ data: null, error: new Error('Supabase not initialized') }),
    delete: () => Promise.resolve({ data: null, error: new Error('Supabase not initialized') }),
  }),
  auth: {
    signIn: () => Promise.resolve({ data: null, error: new Error('Supabase not initialized') }),
  }
} as any;

// Client-side Supabase client
const isConfigValid = validateSupabaseConfig();
export const supabase = (isConfigValid && supabaseUrl && supabaseAnonKey)
  ? createClient(supabaseUrl, supabaseAnonKey)
  : placeholderClient;

// Server-side Supabase client with service role key (for admin operations)
export const supabaseAdmin = (isConfigValid && supabaseServiceKey && supabaseUrl)
  ? createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    })
  : placeholderClient;

// Database types (will be generated after migration)
export type Database = {
  public: {
    Tables: {
      barangay: {
        Row: {
          barangay_id: number
          barangay_name: string
          seal: 'yes' | 'no'
          description: string | null
          is_active: boolean
          created_at: string
          updated_at: string | null
          households: number | null
          population: number | null
          area: number | null
          captain: string | null
          currentStatus: string | null
          history: string | null
        }
        Insert: {
          barangay_id?: number
          barangay_name: string
          seal?: 'yes' | 'no'
          description?: string | null
          is_active?: boolean
          created_at?: string
          updated_at?: string | null
          households?: number | null
          population?: number | null
          area?: number | null
          captain?: string | null
          currentStatus?: string | null
          history?: string | null
        }
        Update: {
          barangay_id?: number
          barangay_name?: string
          seal?: 'yes' | 'no'
          description?: string | null
          is_active?: boolean
          created_at?: string
          updated_at?: string | null
          households?: number | null
          population?: number | null
          area?: number | null
          captain?: string | null
          currentStatus?: string | null
          history?: string | null
        }
      }
      // Add other table types as needed
    }
  }
}

// Helper functions for common operations
export const supabaseHelpers = {
  // Test connection
  async testConnection() {
    try {
      const { data, error } = await supabase
        .from('barangay')
        .select('count')
        .limit(1)
      
      if (error) throw error
      return { success: true, message: 'Connected to Supabase successfully' }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  },

  // Get all barangays
  async getAllBarangays() {
    const { data, error } = await supabase
      .from('barangay')
      .select('*')
      .eq('is_active', true)
      .order('barangay_name')
    
    if (error) throw error
    return data
  },

  // Update barangay seal status
  async updateBarangaySeal(barangayId: number, sealStatus: 'yes' | 'no') {
    const { data, error } = await supabaseAdmin
      .from('barangay')
      .update({ seal: sealStatus })
      .eq('barangay_id', barangayId)
      .select()
    
    if (error) throw error
    return data[0]
  }
}