"""python3 -m unittest discover -s relay/mac/tests"""
import os
import sys
import tempfile
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(HERE)), "sync"))

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(HERE)), "sync", "tests"))

import lattice_relay_agent as agent_mod  # noqa: E402
from test_relay_sync import make_db  # noqa: E402


class DecisionTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        db = os.path.join(self.dir, "mac.db")
        make_db(db)
        cfg = dict(agent_mod.DEFAULTS)
        cfg.update({
            "mac_db": db,
            "state_file": os.path.join(self.dir, "state.json"),
            "status_file": os.path.join(self.dir, "status.json"),
            "trash_dir": os.path.join(self.dir, "trash"),
            "log_file": os.path.join(self.dir, "agent.log"),
            "failback_max_wait_s": 60,
        })
        with mock.patch.object(agent_mod, "RELAY_DIR", self.dir):
            self.agent = agent_mod.Agent(cfg)

    def report(self, recent):
        return {"hello": {"cloud": {"recent_events": recent}}}

    def test_never_offers_an_unhealthy_mac(self):
        with mock.patch.object(self.agent, "local_healthy", return_value=False):
            self.assertFalse(self.agent.should_offer_mac(self.report(0)))

    def test_offers_a_healthy_mac_when_the_cloud_is_quiet(self):
        with mock.patch.object(self.agent, "local_healthy", return_value=True):
            self.assertTrue(self.agent.should_offer_mac(self.report(0)))

    def test_holds_the_phone_on_a_busy_cloud_then_gives_up_waiting(self):
        with mock.patch.object(self.agent, "local_healthy", return_value=True):
            self.assertFalse(self.agent.should_offer_mac(self.report(12)))
            self.agent.cloud_busy_since = time.time() - 61
            self.assertTrue(self.agent.should_offer_mac(self.report(12)))

    def test_an_open_forward_stays_open_while_healthy(self):
        self.agent.forward_open = True
        with mock.patch.object(self.agent, "local_healthy", return_value=True):
            self.assertTrue(self.agent.should_offer_mac(self.report(50)))

    def test_state_round_trips_without_the_report(self):
        self.agent.state["last_report"] = {"big": "x"}
        self.agent.state["cycles"] = 7
        self.agent.save_state()
        self.assertEqual(self.agent._load_state()["cycles"], 7)
        self.assertNotIn("last_report", self.agent._load_state())

    def test_forward_uses_the_control_socket_and_tracks_state(self):
        self.agent.master = mock.Mock()
        self.agent.cfg["ct_host"] = "10.0.0.2"
        ok = mock.Mock(returncode=0, stderr="")
        with mock.patch.object(agent_mod.subprocess, "run", return_value=ok) as run:
            self.agent.forward(True)
            args = run.call_args[0][0]
            self.assertIn("-O", args)
            self.assertIn("forward", args)
            self.assertIn("127.0.0.1:18973:127.0.0.1:8973", args)
            self.assertTrue(self.agent.forward_open)
            self.agent.forward(False)
            self.assertIn("cancel", run.call_args[0][0])
            self.assertFalse(self.agent.forward_open)


if __name__ == "__main__":
    unittest.main()
