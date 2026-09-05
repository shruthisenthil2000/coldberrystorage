export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      farmers: {
        Row: {
          created_at: string
          farm_name: string
          id: string
          name: string
          phone: string | null
        }
        Insert: {
          created_at?: string
          farm_name: string
          id?: string
          name: string
          phone?: string | null
        }
        Update: {
          created_at?: string
          farm_name?: string
          id?: string
          name?: string
          phone?: string | null
        }
        Relationships: []
      }
      incidents: {
        Row: {
          description: string
          id: string
          locker_id: string
          reported_at: string
          status: Database["public"]["Enums"]["incident_status"]
          type: Database["public"]["Enums"]["incident_type"]
        }
        Insert: {
          description: string
          id?: string
          locker_id: string
          reported_at?: string
          status?: Database["public"]["Enums"]["incident_status"]
          type: Database["public"]["Enums"]["incident_type"]
        }
        Update: {
          description?: string
          id?: string
          locker_id?: string
          reported_at?: string
          status?: Database["public"]["Enums"]["incident_status"]
          type?: Database["public"]["Enums"]["incident_type"]
        }
        Relationships: [
          {
            foreignKeyName: "incidents_locker_id_fkey"
            columns: ["locker_id"]
            isOneToOne: false
            referencedRelation: "lockers"
            referencedColumns: ["id"]
          },
        ]
      }
      lockers: {
        Row: {
          capacity: number
          created_at: string
          id: string
          locker_number: string
          status: Database["public"]["Enums"]["locker_status"]
          temperature: number
          zone: string
        }
        Insert: {
          capacity: number
          created_at?: string
          id?: string
          locker_number: string
          status?: Database["public"]["Enums"]["locker_status"]
          temperature?: number
          zone: string
        }
        Update: {
          capacity?: number
          created_at?: string
          id?: string
          locker_number?: string
          status?: Database["public"]["Enums"]["locker_status"]
          temperature?: number
          zone?: string
        }
        Relationships: []
      }
      reservations: {
        Row: {
          cancelled_at: string | null
          check_in_deadline: string
          checked_in_at: string | null
          crate_count: number
          dropoff_code: string
          farmer_id: string
          harvest_date: string
          id: string
          locker_id: string
          moved_at: string | null
          moved_from_locker_id: string | null
          picked_up_at: string | null
          pickup_code: string
          reserved_at: string
          slot: string
          status: Database["public"]["Enums"]["reservation_status"]
        }
        Insert: {
          cancelled_at?: string | null
          check_in_deadline: string
          checked_in_at?: string | null
          crate_count: number
          dropoff_code?: string
          farmer_id: string
          harvest_date?: string
          id?: string
          locker_id: string
          moved_at?: string | null
          moved_from_locker_id?: string | null
          picked_up_at?: string | null
          pickup_code?: string
          reserved_at?: string
          slot: string
          status?: Database["public"]["Enums"]["reservation_status"]
        }
        Update: {
          cancelled_at?: string | null
          check_in_deadline?: string
          checked_in_at?: string | null
          crate_count?: number
          dropoff_code?: string
          farmer_id?: string
          harvest_date?: string
          id?: string
          locker_id?: string
          moved_at?: string | null
          moved_from_locker_id?: string | null
          picked_up_at?: string | null
          pickup_code?: string
          reserved_at?: string
          slot?: string
          status?: Database["public"]["Enums"]["reservation_status"]
        }
        Relationships: [
          {
            foreignKeyName: "reservations_farmer_id_fkey"
            columns: ["farmer_id"]
            isOneToOne: false
            referencedRelation: "farmers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reservations_locker_id_fkey"
            columns: ["locker_id"]
            isOneToOne: false
            referencedRelation: "lockers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reservations_moved_from_locker_id_fkey"
            columns: ["moved_from_locker_id"]
            isOneToOne: false
            referencedRelation: "lockers"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      locker_used_crates:
        | { Args: { _exclude?: string; _locker_id: string }; Returns: number }
        | {
            Args: { _exclude?: string; _locker_id: string; _slot?: string }
            Returns: number
          }
      mark_locker_out_of_service: {
        Args: {
          _locker_id: string
          _status: Database["public"]["Enums"]["locker_status"]
        }
        Returns: undefined
      }
      resolve_incident: { Args: { _incident_id: string }; Returns: undefined }
      restore_locker: {
        Args: {
          _cooling_fixed: boolean
          _locker_id: string
          _status: Database["public"]["Enums"]["locker_status"]
        }
        Returns: undefined
      }
    }
    Enums: {
      incident_status: "OPEN" | "INVESTIGATING" | "RESOLVED"
      incident_type:
        | "TEMPERATURE"
        | "POWER"
        | "DOOR"
        | "SPOILAGE"
        | "OTHER"
        | "MECHANISM"
      locker_status:
        | "AVAILABLE"
        | "RESERVED"
        | "IN_STORAGE"
        | "MAINTENANCE"
        | "BREAKDOWN"
      reservation_status:
        | "RESERVED"
        | "CHECKED_IN"
        | "STORED"
        | "PICKED_UP"
        | "CANCELLED"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
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
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
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
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
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
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      incident_status: ["OPEN", "INVESTIGATING", "RESOLVED"],
      incident_type: [
        "TEMPERATURE",
        "POWER",
        "DOOR",
        "SPOILAGE",
        "OTHER",
        "MECHANISM",
      ],
      locker_status: [
        "AVAILABLE",
        "RESERVED",
        "IN_STORAGE",
        "MAINTENANCE",
        "BREAKDOWN",
      ],
      reservation_status: [
        "RESERVED",
        "CHECKED_IN",
        "STORED",
        "PICKED_UP",
        "CANCELLED",
      ],
    },
  },
} as const
