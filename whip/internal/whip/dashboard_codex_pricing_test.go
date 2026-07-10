package whip

import "testing"

func TestDashboardCodexCostUSDGPT56Models(t *testing.T) {
	tests := []struct {
		model      string
		inputPerM  float64
		cachedPerM float64
		outputPerM float64
	}{
		{model: "gpt-5.6-sol", inputPerM: 5, cachedPerM: 0.5, outputPerM: 30},
		{model: "gpt-5.6-terra", inputPerM: 2.5, cachedPerM: 0.25, outputPerM: 15},
		{model: "gpt-5.6-luna", inputPerM: 1, cachedPerM: 0.1, outputPerM: 6},
	}

	for _, tt := range tests {
		t.Run(tt.model, func(t *testing.T) {
			cases := []struct {
				name         string
				inputTokens  int
				cachedTokens int
				outputTokens int
				want         float64
			}{
				{name: "input", inputTokens: 1_000_000, want: tt.inputPerM},
				{name: "cached input", inputTokens: 1_000_000, cachedTokens: 1_000_000, want: tt.cachedPerM},
				{name: "output", outputTokens: 1_000_000, want: tt.outputPerM},
			}

			for _, tc := range cases {
				t.Run(tc.name, func(t *testing.T) {
					cost, ok := dashboardCodexCostUSD(tt.model, tc.inputTokens, tc.cachedTokens, tc.outputTokens)
					if !ok {
						t.Fatalf("expected pricing for %s", tt.model)
					}
					if diff := cost - tc.want; diff > 1e-9 || diff < -1e-9 {
						t.Errorf("got %f, want %f", cost, tc.want)
					}
				})
			}
		})
	}
}
