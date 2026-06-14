export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  kbagent: {
    Tables: {
      active_sessions: {
        Row: {
          artifact_id: string
          last_event_at: string
          pid: number
          started_at: string
          window_minutes: number
          workspace_name: string
        }
        Insert: {
          artifact_id: string
          last_event_at?: string
          pid: number
          started_at?: string
          window_minutes: number
          workspace_name: string
        }
        Update: {
          artifact_id?: string
          last_event_at?: string
          pid?: number
          started_at?: string
          window_minutes?: number
          workspace_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "active_sessions_artifact_id_fkey"
            columns: ["artifact_id"]
            isOneToOne: true
            referencedRelation: "artifacts"
            referencedColumns: ["id"]
          },
        ]
      }
      artifacts: {
        Row: {
          artifact_type: string
          external_id: string
          id: string
          merged_at: string | null
          metadata: Json | null
          provider: string
          review_cycle_count: number
          ticket_id: string
        }
        Insert: {
          artifact_type: string
          external_id: string
          id?: string
          merged_at?: string | null
          metadata?: Json | null
          provider: string
          review_cycle_count?: number
          ticket_id: string
        }
        Update: {
          artifact_type?: string
          external_id?: string
          id?: string
          merged_at?: string | null
          metadata?: Json | null
          provider?: string
          review_cycle_count?: number
          ticket_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "artifacts_ticket_id_fkey"
            columns: ["ticket_id"]
            isOneToOne: false
            referencedRelation: "tickets"
            referencedColumns: ["id"]
          },
        ]
      }
      events: {
        Row: {
          artifact_id: string
          created_at: string
          error: string | null
          event_type: string
          id: string
          payload: Json
          processed_at: string | null
          processing_started_at: string | null
          retry_count: number
          status: string
        }
        Insert: {
          artifact_id: string
          created_at?: string
          error?: string | null
          event_type: string
          id?: string
          payload: Json
          processed_at?: string | null
          processing_started_at?: string | null
          retry_count?: number
          status?: string
        }
        Update: {
          artifact_id?: string
          created_at?: string
          error?: string | null
          event_type?: string
          id?: string
          payload?: Json
          processed_at?: string | null
          processing_started_at?: string | null
          retry_count?: number
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "events_artifact_id_fkey"
            columns: ["artifact_id"]
            isOneToOne: false
            referencedRelation: "artifacts"
            referencedColumns: ["id"]
          },
        ]
      }
      tickets: {
        Row: {
          external_id: string
          id: string
          priority: string | null
          provider: string
          stage: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          external_id: string
          id?: string
          priority?: string | null
          provider: string
          stage: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          external_id?: string
          id?: string
          priority?: string | null
          provider?: string
          stage?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tickets_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_integrations: {
        Row: {
          external_id: string
          id: string
          metadata: Json | null
          provider: string
          role: string
          workspace_id: string
        }
        Insert: {
          external_id: string
          id?: string
          metadata?: Json | null
          provider: string
          role: string
          workspace_id: string
        }
        Update: {
          external_id?: string
          id?: string
          metadata?: Json | null
          provider?: string
          role?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_integrations_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspaces: {
        Row: {
          id: string
          name: string
          slug: string
        }
        Insert: {
          id?: string
          name: string
          slug: string
        }
        Update: {
          id?: string
          name?: string
          slug?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DefaultSchema = Database[Extract<keyof Database, "kbagent">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof Database },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof Database
  }
    ? keyof (Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        Database[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof Database }
  ? (Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      Database[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof Database },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof Database
  }
    ? keyof Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof Database }
  ? Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof Database },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof Database
  }
    ? keyof Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof Database }
  ? Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof Database },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof Database
  }
    ? keyof Database[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof Database }
  ? Database[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof Database },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof Database
  }
    ? keyof Database[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends { schema: keyof Database }
  ? Database[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never
