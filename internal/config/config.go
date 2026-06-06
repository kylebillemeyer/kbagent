package config

import (
	"os"
	"path/filepath"

	"github.com/spf13/viper"
)

type Config struct {
	Daemon   DaemonConfig   `mapstructure:"daemon"`
	Provider ProviderConfig `mapstructure:"provider"`
}

type DaemonConfig struct {
	RepoPath        string `mapstructure:"repo_path"`
	WorktreesDir    string `mapstructure:"worktrees_dir"`
	DockerImage     string `mapstructure:"docker_image"`
	LogFile         string `mapstructure:"log_file"`
	TicketProvider  string `mapstructure:"ticket_provider"`
	MaxTurns        int    `mapstructure:"max_turns"`
	SleepNoWork     int    `mapstructure:"sleep_no_work"`
	SleepError      int    `mapstructure:"sleep_error"`
	KeychainService string `mapstructure:"keychain_service"`
	ValidateCmd     string `mapstructure:"validate_cmd"`
}

type ProviderConfig struct {
	GitHub GitHubConfig `mapstructure:"github"`
	Plane  PlaneConfig  `mapstructure:"plane"`
}

type GitHubConfig struct {
	Repo string `mapstructure:"repo"`
}

type PlaneConfig struct {
	BaseURL           string `mapstructure:"base_url"`
	WorkspaceSlug     string `mapstructure:"workspace_slug"`
	ProjectID         string `mapstructure:"project_id"`
	StateBacklog      string `mapstructure:"state_backlog"`
	StateInProgress   string `mapstructure:"state_in_progress"`
	StateInReview     string `mapstructure:"state_in_review"`
	LabelSpecApproved string `mapstructure:"label_spec_approved"`
	LabelNeedsInput   string `mapstructure:"label_needs_input"`
}

func Load(cfgFile string) (*Config, error) {
	if cfgFile != "" {
		viper.SetConfigFile(cfgFile)
	} else {
		viper.SetConfigName("kbagent")
		viper.SetConfigType("toml")
		viper.AddConfigPath(".")
		viper.AddConfigPath(filepath.Join(os.Getenv("HOME"), ".config", "kbagent"))
	}

	viper.SetDefault("daemon.ticket_provider", "github")
	viper.SetDefault("daemon.max_turns", 50)
	viper.SetDefault("daemon.sleep_no_work", 1800)
	viper.SetDefault("daemon.sleep_error", 300)
	viper.SetDefault("daemon.docker_image", "agent")
	viper.SetDefault("daemon.log_file", filepath.Join(os.Getenv("HOME"), "Library", "Logs", "kbagent.log"))
	viper.SetDefault("daemon.keychain_service", "kbagent")
	viper.SetDefault("provider.plane.base_url", "https://api.plane.so")

	if err := viper.ReadInConfig(); err != nil {
		return nil, err
	}

	var cfg Config
	if err := viper.Unmarshal(&cfg); err != nil {
		return nil, err
	}
	return &cfg, nil
}
