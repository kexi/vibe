export interface VibeConfig {
  copy?: {
    files?: string[];
    files_prepend?: string[];
    files_append?: string[];
    dirs?: string[];
    dirs_prepend?: string[];
    dirs_append?: string[];
  };
  hooks?: {
    pre_start?: string[];
    pre_start_prepend?: string[];
    pre_start_append?: string[];
    post_start?: string[];
    post_start_prepend?: string[];
    post_start_append?: string[];
    pre_clean?: string[];
    pre_clean_prepend?: string[];
    pre_clean_append?: string[];
    post_clean?: string[];
    post_clean_prepend?: string[];
    post_clean_append?: string[];
  };
  worktree?: {
    path_script?: string;
  };
  clean?: {
    delete_branch?: boolean;
  };
}
