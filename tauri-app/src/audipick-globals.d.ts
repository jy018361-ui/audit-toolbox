export {};

declare global {
  interface Window {
    pdfjsLib?: {
      GlobalWorkerOptions: { workerSrc: string };
      getDocument: (options: Record<string, unknown>) => {
        promise: Promise<any>;
      };
    };
    RuleEngine?: {
      getAllSelectableRules: () => Array<{
        id: string;
        name: string;
        shortName?: string;
        description?: string;
        category?: string;
        version?: string;
      }>;
      getFieldsForRule: (id: string) => Array<{ key: string; label: string }>;
      getRulePrompt: (id: string) => string;
      getCustomRules: () => Array<Record<string, unknown>>;
      setCustomRules: (rules: Array<Record<string, unknown>>) => void;
      createBlankCustomRule: (
        name: string,
        kind: string,
      ) => Record<string, unknown>;
      updateCustomRule: (id: string, patch: Record<string, unknown>) => boolean;
      deleteCustomRule: (id: string) => void;
      resetFieldsCache: (id?: string) => void;
    };
    RevenueWorkpaper?: Record<string, unknown>;
    FieldSet?: Record<string, unknown>;
  }
}
