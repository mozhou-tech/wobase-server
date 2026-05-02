export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export interface Database {
  public: {
    Tables: {
      apps: {
        Row: {
          id: string;
          app_key: string;
          name: string;
          platform: 'ios' | 'android' | 'web' | 'desktop';
          status: 'active' | 'disabled';
          metadata: Json;
          ext_schema_prefix: string | null;
          login_methods: string[];
          created_at: string;
        };
        Insert: {
          id?: string;
          app_key: string;
          name: string;
          platform: 'ios' | 'android' | 'web' | 'desktop';
          status?: 'active' | 'disabled';
          metadata?: Json;
          ext_schema_prefix?: string | null;
          login_methods?: string[];
          created_at?: string;
        };
        Update: {
          id?: string;
          app_key?: string;
          name?: string;
          platform?: 'ios' | 'android' | 'web' | 'desktop';
          status?: 'active' | 'disabled';
          metadata?: Json;
          ext_schema_prefix?: string | null;
          login_methods?: string[];
          created_at?: string;
        };
      };
      app_users: {
        Row: {
          id: string;
          app_id: string;
          user_id: string;
          env: 'dev' | 'test' | 'prod';
          user_tier: 'basic' | 'paid' | 'team';
          tier_expires_at: string | null;
          app_user_status: 'active' | 'banned' | 'deleted';
          metadata: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          app_id: string;
          user_id: string;
          env: 'dev' | 'test' | 'prod';
          user_tier?: 'basic' | 'paid' | 'team';
          tier_expires_at?: string | null;
          app_user_status?: 'active' | 'banned' | 'deleted';
          metadata?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          app_id?: string;
          user_id?: string;
          env?: 'dev' | 'test' | 'prod';
          user_tier?: 'basic' | 'paid' | 'team';
          tier_expires_at?: string | null;
          app_user_status?: 'active' | 'banned' | 'deleted';
          metadata?: Json;
          created_at?: string;
          updated_at?: string;
        };
      };
      user_profiles: {
        Row: {
          id: string;
          app_id: string;
          env: 'dev' | 'test' | 'prod';
          user_id: string;
          display_name: string | null;
          avatar_url: string | null;
          phone: string | null;
          country_code: string | null;
          metadata: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          app_id: string;
          env: 'dev' | 'test' | 'prod';
          user_id: string;
          display_name?: string | null;
          avatar_url?: string | null;
          phone?: string | null;
          country_code?: string | null;
          metadata?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          app_id?: string;
          env?: 'dev' | 'test' | 'prod';
          user_id?: string;
          display_name?: string | null;
          avatar_url?: string | null;
          phone?: string | null;
          country_code?: string | null;
          metadata?: Json;
          created_at?: string;
          updated_at?: string;
        };
      };
      wallet_accounts: {
        Row: {
          id: string;
          app_id: string;
          user_id: string;
          env: 'dev' | 'test' | 'prod';
          currency: 'CNY' | 'USD' | 'points';
          available_balance: number;
          frozen_balance: number;
          updated_at: string;
        };
        Insert: {
          id?: string;
          app_id: string;
          user_id: string;
          env: 'dev' | 'test' | 'prod';
          currency: 'CNY' | 'USD' | 'points';
          available_balance?: number;
          frozen_balance?: number;
          updated_at?: string;
        };
        Update: {
          id?: string;
          app_id?: string;
          user_id?: string;
          env?: 'dev' | 'test' | 'prod';
          currency?: 'CNY' | 'USD' | 'points';
          available_balance?: number;
          frozen_balance?: number;
          updated_at?: string;
        };
      };
      wallet_transactions: {
        Row: {
          id: string;
          app_id: string;
          env: 'dev' | 'test' | 'prod';
          user_id: string;
          account_id: string;
          biz_type: 'recharge' | 'consume' | 'refund' | 'settle' | 'withdraw' | 'freeze' | 'unfreeze';
          amount: number;
          direction: 'in' | 'out';
          status: 'pending' | 'success' | 'failed';
          biz_no: string;
          ext: Json;
          created_at: string;
        };
        Insert: {
          id?: string;
          app_id: string;
          env: 'dev' | 'test' | 'prod';
          user_id: string;
          account_id: string;
          biz_type: 'recharge' | 'consume' | 'refund' | 'settle' | 'withdraw' | 'freeze' | 'unfreeze';
          amount: number;
          direction: 'in' | 'out';
          status?: 'pending' | 'success' | 'failed';
          biz_no: string;
          ext?: Json;
          created_at?: string;
        };
        Update: {
          id?: string;
          app_id?: string;
          env?: 'dev' | 'test' | 'prod';
          user_id?: string;
          account_id?: string;
          biz_type?: 'recharge' | 'consume' | 'refund' | 'settle' | 'withdraw' | 'freeze' | 'unfreeze';
          amount?: number;
          direction?: 'in' | 'out';
          status?: 'pending' | 'success' | 'failed';
          biz_no?: string;
          ext?: Json;
          created_at?: string;
        };
      };
    };
    Functions: {
      recompute_app_user_tier: {
        Args: {
          p_app_id: string;
          p_env: string;
          p_user_id: string;
          p_reason?: string;
          p_operator_user_id?: string;
        };
        Returns: void;
      };
    };
  };
}