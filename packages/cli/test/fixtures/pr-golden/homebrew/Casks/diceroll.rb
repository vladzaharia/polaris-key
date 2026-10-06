cask "diceroll" do
  version "1.2.0"
  sha256 "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"

  url "https://key.example.test/diceroll/distribution/blobs/sha256/cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
  name "Diceroll"
  desc "A cozy dice-rolling roguelite"
  homepage "https://diceroll.example.test"

  livecheck do
    url "https://key.example.test/diceroll/distribution/download.json"
    strategy :json do |json|
      json.dig("release", "version")
    end
  end

  auto_updates true

  app "Diceroll.app"
end
