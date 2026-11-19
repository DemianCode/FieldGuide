package com.demian.engine

import com.demian.engine.LinkPolicy.Target
import org.junit.Assert.assertEquals
import org.junit.Test

class LinkPolicyTest {
    @Test
    fun `bundled app pages stay in the app`() {
        assertEquals(Target.IN_APP, LinkPolicy.classify(LinkPolicy.START_URL))
        assertEquals(Target.IN_APP, LinkPolicy.classify("https://APPASSETS.androidplatform.net/assets/web/index.html#x"))
    }

    @Test
    fun `web links open in the browser`() {
        assertEquals(Target.EXTERNAL, LinkPolicy.classify("https://en.wikipedia.org/wiki/Australian_magpie"))
        assertEquals(Target.EXTERNAL, LinkPolicy.classify("http://example.com/"))
        assertEquals(Target.EXTERNAL, LinkPolicy.classify("mailto:someone@example.com"))
    }

    @Test
    fun `lookalike hosts are not the app`() {
        assertEquals(Target.EXTERNAL, LinkPolicy.classify("https://appassets.androidplatform.net.evil.example/"))
        assertEquals(Target.EXTERNAL, LinkPolicy.classify("https://evil.example/?h=appassets.androidplatform.net"))
    }

    @Test
    fun `other schemes and junk are blocked`() {
        assertEquals(Target.BLOCKED, LinkPolicy.classify("javascript:alert(1)"))
        assertEquals(Target.BLOCKED, LinkPolicy.classify("file:///sdcard/x.html"))
        assertEquals(Target.BLOCKED, LinkPolicy.classify("intent://scan/#Intent;end"))
        assertEquals(Target.BLOCKED, LinkPolicy.classify("not a url"))
        assertEquals(Target.BLOCKED, LinkPolicy.classify("http://app assets/"))
    }
}
