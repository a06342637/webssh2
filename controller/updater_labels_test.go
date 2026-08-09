package controller

import (
	"strings"
	"testing"
)

// findFlagValue returns the value that follows the first occurrence of flag.
func findFlagValues(args []string, flag string) []string {
	var values []string
	for i := 0; i < len(args)-1; i++ {
		if args[i] == flag {
			values = append(values, args[i+1])
		}
	}
	return values
}

func TestUpdaterRunArgsLeavesComposeProject(t *testing.T) {
	// The updater image is built by compose, so it carries com.docker.compose.*
	// labels that docker run would otherwise inherit. Inheriting them makes the
	// updater look like a service instance of this project, and the compose up it
	// runs kills it mid-update, leaving the old container deleted and the new one
	// never started.
	args := updaterRunArgs("webssh-updater-1", "/root/webssh2", "/app/source", "webssh2-webssh", "echo hi")
	labels := findFlagValues(args, "--label")

	overrides := map[string]string{
		"com.docker.compose.project": updaterComposeProject,
		"com.docker.compose.service": "updater",
		"com.docker.compose.oneoff":  "True",
	}
	for key, want := range overrides {
		found := ""
		for _, label := range labels {
			if strings.HasPrefix(label, key+"=") {
				found = strings.TrimPrefix(label, key+"=")
			}
		}
		if found != want {
			t.Errorf("label %s = %q, want %q (inherited compose labels make the updater kill itself)", key, found, want)
		}
	}

	if updaterComposeProject == "webssh2" {
		t.Error("updater project name must differ from the deployment project name")
	}
}

func TestUpdaterRunArgsKeepsIdentifyingLabel(t *testing.T) {
	// Status polling and cleanup both find helpers through this label.
	args := updaterRunArgs("webssh-updater-1", "/root/webssh2", "/app/source", "webssh2-webssh", "echo hi")
	for _, label := range findFlagValues(args, "--label") {
		if label == "webssh.updater=true" {
			return
		}
	}
	t.Fatal("webssh.updater=true label is missing; status polling and cleanup would lose track of the helper")
}

func TestUpdaterRunArgsOrderAndPayload(t *testing.T) {
	script := "log 'update'"
	args := updaterRunArgs("webssh-updater-42", "/srv/app", "/app/source", "some-image", script)

	if len(args) < 2 || args[0] != "run" || args[1] != "-d" {
		t.Fatalf("args must start with `run -d`, got %v", args[:min(2, len(args))])
	}
	if got := findFlagValues(args, "--name"); len(got) != 1 || got[0] != "webssh-updater-42" {
		t.Errorf("--name = %v, want [webssh-updater-42]", got)
	}

	// Docker only treats flags before the image as its own; anything after is the
	// container command. Labels landing after the image would be silently ignored.
	imageIdx := -1
	for i, a := range args {
		if a == "some-image" {
			imageIdx = i
			break
		}
	}
	if imageIdx < 0 {
		t.Fatal("image missing from args")
	}
	for i, a := range args {
		if a == "--label" && i > imageIdx {
			t.Errorf("--label at %d appears after the image at %d; docker would ignore it", i, imageIdx)
		}
	}
	if args[len(args)-1] != script || args[len(args)-2] != "-lc" {
		t.Errorf("script must be the final `-lc <script>` pair, got %v", args[len(args)-2:])
	}

	mounts := findFlagValues(args, "-v")
	wantMount := "/srv/app:/srv/app"
	if !containsString(mounts, wantMount) {
		t.Errorf("mounts %v missing %q", mounts, wantMount)
	}
	if !containsString(mounts, "/var/run/docker.sock:/var/run/docker.sock") {
		t.Errorf("mounts %v missing the docker socket", mounts)
	}
}

func containsString(values []string, want string) bool {
	for _, v := range values {
		if v == want {
			return true
		}
	}
	return false
}
